/**
 * The same surface as `src/ui/primitives.tsx`, against the cell renderer.
 *
 * Keeping the API identical is the point: if `App` can be pointed at this
 * module without edits, the renderer is genuinely swappable and the invariant
 * that only one module knows the backend has paid for itself.
 */

import React, {
  createContext, useContext, useEffect, useReducer, useRef,
  type ReactNode,
} from "react";
import { LegacyRoot } from "react-reconciler/constants.js";
import { createRoot, reconciler, toLines, type Root } from "./host.ts";
import { paint, type Screen } from "./screen.ts";
import { renderFrame, HIDE_CURSOR, SHOW_CURSOR } from "./diff.ts";
import {
  parse, ENABLE_PASTE, DISABLE_PASTE, type Key, type KeyEvent,
} from "./input.ts";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "tui-box": { children?: ReactNode; direction?: "row" | "column"; padX?: number };
      "tui-text": {
        children?: ReactNode;
        color?: string;
        bg?: string;
        dim?: boolean;
        bold?: boolean;
        italic?: boolean;
      };
    }
  }
}

export type Color =
  | "black" | "red" | "green" | "yellow" | "blue"
  | "magenta" | "cyan" | "white" | "gray" | "grey";

export type StackProps = {
  children?: ReactNode;
  direction?: "row" | "column";
  padX?: number;
};

export function Stack({ children, direction = "column", padX }: StackProps) {
  return <tui-box direction={direction} padX={padX}>{children}</tui-box>;
}

export type LabelProps = {
  children?: ReactNode;
  color?: Color | string;
  bg?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
};

export function Label({ children, color, bg, dim, bold, italic }: LabelProps) {
  return (
    <tui-text color={color} bg={bg} dim={dim} bold={bold} italic={italic}>
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
export function Settled<T>({
  items,
  render,
}: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
}) {
  return <tui-box direction="column">{items.map((item, i) => render(item, i))}</tui-box>;
}


type Session = {
  out: NodeJS.WriteStream;
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
 */
function Session({ value, children }: { value: Session; children: ReactNode }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    value.out.on("resize", bump);
    return () => {
      value.out.off("resize", bump);
    };
  }, [value]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
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

export function useKeys(fn: (char: string, key: Key) => void): void {
  useSubscription(useSession().keys, (e: KeyEvent) => fn(e.char, e.key));
}

export function usePaste(fn: (text: string) => void): void {
  useSubscription(useSession().pastes, fn);
}

export function useStdout(): { stdout: NodeJS.WriteStream } {
  return { stdout: useSession().out };
}

export function useApp(): { exit: () => void } {
  return { exit: useSession().exit };
}

export type Instance = {
  rerender: (node: ReactNode) => void;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
};

export type MountOptions = {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
};

export function mount(node: ReactNode, options: MountOptions = {}): Instance {
  const out = options.stdout ?? process.stdout;
  const input = options.stdin ?? process.stdin;

  const root: Root = createRoot();
  const container = reconciler.createContainer(
    root, LegacyRoot, null, false, null, "tui", () => {}, () => {}, () => {}, null,
  );

  let prev: Screen | null = null;
  let scheduled = false;
  let done = () => {};
  const exited = new Promise<void>((r) => { done = r; });

  const draw = () => {
    scheduled = false;
    const next = paint(toLines(root), out.columns ?? 80);
    out.write(renderFrame(prev, next, out.rows ?? 24));
    prev = next;
  };

  // React commits synchronously here, and a single update can commit more than
  // once; coalescing to a microtask keeps one frame per turn of the loop.
  root.onRender = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(draw);
  };

  const session: Session = {
    out,
    exit: () => instance.unmount(),
    keys: new Set(),
    pastes: new Set(),
  };

  const onData = (chunk: Buffer | string) => {
    const { events, pastes } = parse(String(chunk));
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
      <Session value={session}>{next}</Session>, container, null, null,
    );
    reconciler.flushSyncWork();
  };

  let unmounted = false;
  const instance: Instance = {
    rerender,
    unmount() {
      if (unmounted) return;
      unmounted = true;
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
