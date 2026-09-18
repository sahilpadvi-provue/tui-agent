/**
 * The cell renderer as a backend.
 *
 * A grid the height of the content, with the terminal as a window onto its
 * last rows. Nothing above that window is ever addressed, so settled output
 * still reaches the terminal's own scrollback, and a resize cannot leave a
 * stack of ghosts behind -- there is no erase-by-line-count step to miscount,
 * which is what ink#907 was.
 *
 * This is the default backend and the one the shipped binary carries.
 */

import React, {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { LegacyRoot } from "react-reconciler/constants.js";
import type {
  Backend, BoxProps, Instance, Key, KeyEvent, MountOptions, SettledProps, TextProps,
} from "../backend.ts";
import { createRoot, reconciler, toLines, type Root } from "../render/host.ts";
import { paint, cellAt, type Screen } from "../render/screen.ts";
import { renderFrame, HIDE_CURSOR, SHOW_CURSOR } from "../render/diff.ts";
import { StringDecoder } from "node:string_decoder";
import { Parser, ENABLE_PASTE, DISABLE_PASTE } from "../render/input.ts";
import type { Paint } from "../../theme/index.ts";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "tui-box": {
        children?: ReactNode;
        direction?: "row" | "column";
        padX?: number;
        border?: boolean;
        borderColor?: Paint;
        borderDim?: boolean;
        align?: "start" | "end" | "between";
      };
      "tui-text": {
        children?: ReactNode;
        color?: Paint;
        bg?: Paint;
        dim?: boolean;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
      };
    }
  }
}

function Box({
  children, direction = "column", padX, border, borderColor, borderDim, align,
}: BoxProps) {
  return (
    <tui-box
      direction={direction}
      padX={padX}
      border={border}
      borderColor={borderColor}
      borderDim={borderDim}
      align={align}
    >
      {children}
    </tui-box>
  );
}

function Text({ children, color, bg, dim, bold, italic, underline }: TextProps) {
  return (
    <tui-text color={color} bg={bg} dim={dim} bold={bold} italic={italic} underline={underline}>
      {children}
    </tui-text>
  );
}

/**
 * No separate append-only channel.
 *
 * Ink's `Static` exists because a printed row is unrecoverable, so anything
 * settled has to leave the tree. Here the grid keeps every row and the diff
 * declines to address the ones above the viewport, which reaches the same
 * place by not needing the mechanism.
 */
function Settled<T>({ items, render }: SettledProps<T>) {
  return <tui-box direction="column">{items.map((item, i) => render(item, i))}</tui-box>;
}

type Session = {
  columns: number;
  exit: () => void;
  keys: Set<(e: KeyEvent) => void>;
  pastes: Set<(text: string) => void>;
};

const SessionContext = createContext<Session | null>(null);

function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("hook used outside mount()");
  return s;
}

/**
 * Width is read during render, so a resize has to re-render rather than just
 * repaint -- every wrapped line and every elastic field is derived from it.
 *
 * The width therefore goes into the context value, and a resize replaces that
 * value. Bumping a counter here instead re-renders only this component:
 * `children` is the same element on the way back out, React bails out of the
 * subtree, no host node changes and nothing repaints. The symptom is narrow
 * and easy to miss -- on an idle screen a resize does nothing until the next
 * keystroke, while anything with a timer running looks fine, because its next
 * tick re-renders and picks the new width up. `scripts/quiet-resize-check.tsx`
 * is the guard, and it asserts on a component that has no other reason to
 * render, which is the only arrangement that can tell the two apart.
 */
function Provider({
  out, value, children,
}: {
  out: NodeJS.WriteStream;
  value: Omit<Session, "columns">;
  children: ReactNode;
}) {
  const [columns, setColumns] = useState(out.columns ?? 80);
  useEffect(() => {
    const onResize = () => setColumns(out.columns ?? 80);
    out.on("resize", onResize);
    return () => {
      out.off("resize", onResize);
    };
  }, [out]);
  const session = useMemo(() => ({ ...value, columns }), [value, columns]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Subscribes once and calls through a ref, so a new closure each render is free. */
function useSubscription<T>(set: Set<(v: T) => void>, fn: (v: T) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const call = (v: T) => ref.current(v);
    set.add(call);
    return () => {
      set.delete(call);
    };
  }, [set]);
}

function useKeys(fn: (char: string, key: Key) => void): void {
  useSubscription(useSession().keys, (e: KeyEvent) => fn(e.char, e.key));
}

function usePaste(fn: (text: string) => void): void {
  useSubscription(useSession().pastes, fn);
}

function useColumns(): number {
  return useSession().columns;
}

function useExit(): () => void {
  return useSession().exit;
}

/** 60fps. Nothing in a terminal is shown faster, so a frame above this is a write with no reader. */
export const FRAME_MS = 16;

function mount(node: ReactNode, options: MountOptions = {}): Instance {
  const out = options.stdout ?? process.stdout;
  const input = options.stdin ?? process.stdin;

  const root: Root = createRoot();
  const container = reconciler.createContainer(
    root, LegacyRoot, null, false, null, "tui", () => {}, () => {}, () => {}, null,
  );

  let prev: Screen | null = null;
  let scheduled = false;
  let deferred: ReturnType<typeof setTimeout> | null = null;
  let lastPaint = 0;
  let unmounted = false;
  let done = () => {};
  const exited = new Promise<void>((r) => { done = r; });

  const draw = () => {
    scheduled = false;
    if (deferred !== null) { clearTimeout(deferred); deferred = null; }
    // Unmounting empties the tree, and painting that erases the final frame --
    // which for an inline renderer means the session wipes itself on exit.
    if (unmounted) return;
    lastPaint = performance.now();
    const next = paint(toLines(root), out.columns ?? 80);
    out.write(renderFrame(prev, next, out.rows ?? 24));
    prev = next;
    options.onRender?.();
  };

  // React commits synchronously here, and a single update can commit more than
  // once; coalescing to a microtask keeps one frame per turn of the loop. A
  // microtask alone is not enough under a stream: a token arriving every yield
  // gets its own frame, so 2000 deltas painted 41 times where a terminal could
  // show 5, and the writes for the other 36 went nowhere a human could read.
  //
  // Leading edge deliberately. Waiting out the budget first would put FRAME_MS
  // between a keystroke and the character appearing, which is the one latency
  // in this renderer anybody feels. The timer exists only while a paint is
  // owed, so an idle screen still has no clock running -- `clock:check` is the
  // gate that says so, and a standing frame loop would have made it blind.
  root.onRender = () => {
    if (scheduled) return;
    scheduled = true;
    const since = performance.now() - lastPaint;
    if (since >= FRAME_MS) queueMicrotask(draw);
    else deferred = setTimeout(draw, FRAME_MS - since);
  };

  const session: Omit<Session, "columns"> = {
    exit: () => instance.unmount(),
    keys: new Set(),
    pastes: new Set(),
  };

  const parser = new Parser();
  /**
   * Decode across reads, not within one.
   *
   * `String(buffer)` decodes each chunk alone, so a multi-byte codepoint that
   * lands on a read boundary becomes two replacement characters and the input
   * is corrupted -- `café` arriving as `caf\ufffd\ufffd`. Any non-ASCII
   * character can do it, and a slow link or a paste large enough to fragment
   * is all it takes. `StringDecoder` holds an incomplete sequence and emits it
   * once the next chunk completes it.
   *
   * It lives as long as the mount and is not flushed on the way out. What it
   * could still be holding is half a character nobody finished typing, and
   * there is no longer a screen to show it on.
   */
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text === "") return;
    const { events, pastes } = parser.push(text);
    for (const e of events) for (const fn of [...session.keys]) fn(e);
    for (const text of pastes) for (const fn of [...session.pastes]) fn(text);
  };

  const raw = input.isTTY === true;
  if (raw) {
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    out.write(ENABLE_PASTE);
  }
  out.write(HIDE_CURSOR);

  const rerender = (next: ReactNode) => {
    reconciler.updateContainerSync(
      <Provider out={out} value={session}>{next}</Provider>, container, null, null,
    );
    reconciler.flushSyncWork();
  };

  const instance: Instance = {
    rerender,
    unmount() {
      if (unmounted) return;
      unmounted = true;
      if (deferred !== null) { clearTimeout(deferred); deferred = null; }
      reconciler.updateContainerSync(null, container, null, null);
      reconciler.flushSyncWork();
      if (raw) {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        out.write(DISABLE_PASTE);
      }
      out.write(SHOW_CURSOR + "\n");
      done();
    },
    waitUntilExit: () => exited,
  };

  rerender(node);
  return instance;
}

function renderToText(node: ReactNode, columns: number): string[] {
  const root: Root = createRoot();
  const container = reconciler.createContainer(
    root, LegacyRoot, null, false, null, "tui", () => {}, () => {}, () => {}, null,
  );
  // The hooks have to resolve to something: a tree rendered off-screen may
  // still read the width or subscribe to keys, and throwing there would make
  // this usable only on trees written for it.
  const session: Session = {
    columns, exit: () => {}, keys: new Set(), pastes: new Set(),
  };
  reconciler.updateContainerSync(
    <SessionContext.Provider value={session}>{node}</SessionContext.Provider>,
    container, null, null,
  );
  reconciler.flushSyncWork();

  const screen = paint(toLines(root), columns);
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let row = "";
    for (let x = 0; x < screen.width; x++) row += cellAt(screen, x, y).char;
    rows.push(row.replace(/\s+$/, ""));
  }

  reconciler.updateContainerSync(null, container, null, null);
  reconciler.flushSyncWork();
  return rows;
}

export const cellsBackend: Backend = {
  name: "cells",
  Box,
  Text,
  Settled,
  mount,
  useKeys,
  usePaste,
  useColumns,
  useExit,
  renderToText,
};
