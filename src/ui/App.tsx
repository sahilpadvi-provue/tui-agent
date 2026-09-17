import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Stack, Label, Settled, useKeys, useStdout, useApp, type Color } from "./primitives.tsx";
import { reduce, initialState, type ViewItem } from "./model.ts";
import { Markdown } from "./markdown.tsx";
import { bannerLines } from "./banner.ts";
import {
  BLANK, DEPTH, GUTTER, STEP,
  clip, highlightCommand, measureAt, outputLines, shimmer, shortenPath, styled,
  summariseCall, verbFor, wrap,
  type Line as L,
} from "./layout.ts";
import { radiusLines } from "../permissions/policy.ts";
import type { EventBus } from "../core/bus.ts";
import type { PermissionDecision } from "../core/events.ts";

export type AppProps = {
  bus: EventBus;
  cwd: string;
  model: string;
  version: string;
  /** Where the model runs. Shown once, on launch. */
  backend: string;
  /** How the session is contained, in the words the executor reports. */
  sandbox: string;
  /** Current git branch, when the workspace is a repo. */
  branch?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onPermission: (d: PermissionDecision) => void;
  busy: boolean;
};

/**
 * The screen has two regions and no fixed panes.
 *
 * Settled output is printed once into the terminal's own scrollback, so the
 * user scrolls, searches and copies it with the terminal they already know.
 * Only the live region -- the streaming message, the running tool, the prompt
 * -- redraws. The app therefore occupies exactly as many rows as it needs,
 * and there is no empty band anywhere.
 */
export function App({
  bus, cwd, model, version, backend, sandbox, branch,
  onSubmit, onCancel, onPermission, busy,
}: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [input, setInput] = useState("");
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState<string[]>([]);
  const [phase, setPhase] = useState(0);
  const startedAt = useRef<number | null>(null);
  const wasBusy = useRef(false);
  const { stdout } = useStdout();
  const { exit } = useApp();

  // The only connection to the runtime: a subscription. No calls in, ever.
  useEffect(() => bus.on((e) => dispatch(e)), [bus]);

  useEffect(() => {
    if (wasBusy.current && !busy && queued.length > 0) {
      const [next, ...rest] = queued;
      setQueued(rest);
      onSubmit(next!);
    }
    wasBusy.current = busy;
  }, [busy, queued, onSubmit]);

  // The wave through "working" runs faster than the clock: a second is long
  // enough to look stopped.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setPhase((p) => p + 1), 90);
    return () => clearInterval(id);
  }, [busy]);

  // A local model can think for minutes. Without a clock the screen is
  // indistinguishable from a hang, and the first instinct is to kill it.
  useEffect(() => {
    if (!busy) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const id = setInterval(() => {
      if (startedAt.current) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  useKeys((char, key) => {
    if (state.pending) {
      if (char === "y") onPermission({ kind: "allow", scope: "once" });
      else if (char === "a") onPermission({ kind: "allow", scope: "session" });
      else if (char === "n" || key.escape) onPermission({ kind: "deny", reason: "declined" });
      return;
    }
    // Ctrl-C interrupts the turn while one is running, and quits when idle --
    // but only on a second press, because the first is almost always meant to
    // stop the agent rather than lose the session.
    if (key.ctrl && char === "c") {
      if (busy) {
        onCancel();
        return;
      }
      if (confirmQuit) exit();
      else setConfirmQuit(true);
      return;
    }
    // Ctrl-D on an empty prompt is the usual way out of a REPL.
    if (key.ctrl && char === "d" && !busy && input === "") {
      exit();
      return;
    }
    if (key.escape) {
      if (busy) onCancel();
      else setConfirmQuit(false);
      return;
    }

    setConfirmQuit(false);

    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput("");
      // A turn can run for minutes. Taking the keyboard away for that long
      // means the next instruction has to be held in the user's head until
      // the agent is finished, so it is queued instead.
      if (busy) setQueued((q) => [...q, text]);
      else onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const term = stdout?.columns ?? 80;

  // An item is settled once nothing can change it again. Settled lines are
  // append-only for Static, which holds because a gap depends only on an item
  // and the one before it.
  const settledCount = countSettled(state.items);
  const banner = useMemo(
    () => bannerLines({ version, model, backend, sandbox, cwd: shortenPath(cwd, term - 6) }),
    [version, model, backend, sandbox, cwd, term],
  );
  const settled = useMemo(
    () => [...banner, ...renderRun(state.items.slice(0, settledCount), term, null)],
    [banner, settledCount, term, state.items],
  );
  const lastSettled = state.items[settledCount - 1]?.kind ?? null;
  const live = renderRun(state.items.slice(settledCount), term, lastSettled);

  return (
    <>

      <Settled items={settled} render={(line, i) => <Row key={i} line={line} />} />

      <Stack direction="column">
        {live.map((l, i) => (
          <Row key={`live-${i}`} line={l} />
        ))}

        {state.items.length > 0 && <Label> </Label>}

        {busy && !state.pending && (
          <Stack direction="row" padX={GUTTER}>
            <Label color="cyan">{"\u00b7 "}</Label>
            <Label bold>
              {shimmer("working", phase).map((sp, i) => (
                <Label key={i} color={sp.color}>{sp.text}</Label>
              ))}
            </Label>
            <Label dim>{`  ${formatElapsed(elapsed)} \u00b7 esc to interrupt`}</Label>
          </Stack>
        )}

        {queued.map((q, i) => (
          <Stack key={i} direction="row" padX={GUTTER}>
            <Label dim>{"\u21b3 queued  "}</Label>
            <Label dim>{clip(q, term - GUTTER - 12)}</Label>
          </Stack>
        ))}

        {state.pending ? (
          <Stack direction="column" padX={GUTTER} border borderSides="y" borderColor="yellow">
            <Label bold color="yellow">{`approve ${state.pending.tool}`}</Label>
            {radiusLines(state.pending.radius).map((l, i) => (
              <Label key={i} dim>{clip(l, term - 4)}</Label>
            ))}
            <Label dim>{"[y] once    [a] session    [n] deny"}</Label>
          </Stack>
        ) : (
          <Stack
            direction="row"
            padX={GUTTER}
            border
            borderSides="y"
            borderDim={!confirmQuit}
            borderColor={confirmQuit ? "yellow" : undefined}
          >
            <Label color={confirmQuit ? "yellow" : "cyan"}>
              {confirmQuit ? "! " : "\u203a "}
            </Label>
            {confirmQuit ? (
              <Label color="yellow">ctrl-c again to exit, any key to stay</Label>
            ) : (
              <Label>
                {input}
                <Label>{"\u258f"}</Label>
                {/* The hint is not text you typed, so it must not look like
                    it. An explicit grey reads as absent in a way SGR dim does
                    not -- dim white is still close to white on many themes. */}
                {input === "" && (
                  <Label color="gray">
                    {busy ? " type to queue the next instruction" : " describe a change, or ask about the code"}
                  </Label>
                )}
              </Label>
            )}
          </Stack>
        )}

        <Stack direction="row" padX={GUTTER} align="between">
          <Label dim>{`${basename(cwd)}${branch ? `  ${branch}` : ""}  ${model}`}</Label>
          <Label dim>{`${sandbox}  \u00b7  ${fmt(state.usage.input)}\u2191 ${fmt(state.usage.output)}\u2193`}</Label>
        </Stack>
      </Stack>
    </>
  );
}

/** One step off the terminal's own background: enough to read as a field. */
const BAND = "#2a2a2a";

/** The one place a depth becomes columns. */
function Row({ line }: { line: L }) {
  const pad = " ".repeat(GUTTER + (line.depth ?? 0) * STEP);
  // A rule carries no text, so it has to be handled before the blank-row
  // guard below -- otherwise it renders as an empty line.
  if (line.rule) {
    return <Label dim>{"\u2500".repeat(Math.max(0, line.width ?? 0))}</Label>;
  }
  // An empty Text renders no row at all, so a blank line is a single space.
  if (!line.text) return <Label> </Label>;
  if (line.md) return <Markdown line={line.text} indent={pad} color={line.color} dim={line.dim} />;
  if (line.band) {
    return (
      <Label bg={BAND}>
        {pad}
        {(line.spans ?? [{ text: line.text }]).map((sp, i) => (
          <Label key={i} bg={BAND} color={sp.color} bold={sp.bold} dim={sp.dim}>
            {sp.text}
          </Label>
        ))}
        {" ".repeat(Math.max(0, (line.width ?? 0) - pad.length - line.text.length))}
      </Label>
    );
  }
  if (line.spans) {
    return (
      <Label>
        {pad}
        {line.spans.map((s, i) => (
          <Label key={i} color={s.color} dim={s.dim} bold={s.bold}>
            {s.text}
          </Label>
        ))}
      </Label>
    );
  }
  return (
    <Label color={line.color} dim={line.dim} bold={line.bold}>
      {pad + line.text}
    </Label>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Thousands separator without the noise of full locale formatting. */
function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/**
 * Vertical rhythm.
 *
 * A blank row is the only separator this UI has, so it is spent where the
 * reader changes what they are doing: starting a new exchange, or moving from
 * the agent's work back to its answer. Consecutive tool calls are one
 * continuous action and get none -- spacing them out is what turns a session
 * into a scroll.
 */
function gapBefore(prev: ViewItem["kind"] | null, next: ViewItem["kind"]): number {
  if (prev === null) return 0;
  if (next === "user") return 0;
  // The request and the work it triggered are different things; running them
  // together makes the agent's first move look like part of the sentence.
  if (prev === "user") return 1;
  if (next === "assistant" && prev !== "assistant") return 1;
  if (next === "compaction" || prev === "compaction") return 1;
  return 0;
}

function renderRun(items: ViewItem[], term: number, startingAfter: ViewItem["kind"] | null): L[] {
  const out: L[] = [];
  let prev = startingAfter;
  for (const item of items) {
    // A new request closes the exchange before it with a rule, which reads
    // more clearly than a blank row for the same one-row cost.
    if (prev !== null && item.kind === "user") {
      out.push(BLANK, { text: "", rule: true, width: term }, BLANK);
    }
    for (let i = 0; i < gapBefore(prev, item.kind); i++) out.push(BLANK);
    out.push(...renderItem(item, term));
    prev = item.kind;
  }
  return out;
}

/**
 * How many leading items can never change again.
 *
 * A streaming message, a running tool and everything after them stay live.
 * Stopping at the first unsettled item keeps the settled list append-only,
 * which is what Static requires.
 */
function countSettled(items: ViewItem[]): number {
  let n = 0;
  for (const i of items) {
    const done =
      (i.kind === "assistant" && !i.streaming) ||
      (i.kind === "tool" && !i.running) ||
      i.kind === "user" ||
      i.kind === "error" ||
      i.kind === "compaction" ||
      (i.kind === "reasoning" && i.done);
    if (!done) break;
    n++;
  }
  return n;
}

function renderItem(i: ViewItem, term: number): L[] {
  switch (i.kind) {
    // The request is the loudest thing on screen: it is what everything below
    // it is answering, and the eye should find it without searching.
    // The request is banded rather than bolded: it is a different kind of
    // thing from everything under it, not a louder version of the same thing.
    case "user": {
      const w = measureAt(DEPTH.said, term) - 2;
      return wrap(i.text, w).map((t, n) => ({
        ...styled(
          DEPTH.said,
          n === 0 ? { text: "\u203a ", color: "cyan" } : { text: "  " },
          { text: t },
        ),
        band: true,
        width: term,
      }));
    }

    case "assistant":
      return wrap(i.text, measureAt(DEPTH.said, term)).map((t) => ({
        text: t,
        depth: DEPTH.said,
        md: true,
      }));

    case "reasoning":
      return [{
        text: i.done ? `thought for ${i.chars.toLocaleString()} chars` : "thinking\u2026",
        depth: DEPTH.did,
        dim: true,
      }];

    case "tool": {
      const w = measureAt(DEPTH.did, term);
      // Three weights on one line: a coloured mark carries status, the tool
      // name carries what kind of thing happened, and the argument -- the
      // longest part and the least often needed -- recedes.
      const mark = i.running ? "\u00b7" : i.ok === false ? "\u2717" : "\u2713";
      const markColor = i.running ? "cyan" : i.ok === false ? "red" : "green";
      const verb = verbFor(i.name);
      const summary = i.args !== undefined ? summariseCall(i.name, i.args) : "";
      const room = w - mark.length - verb.length - 3;
      const shown = summary ? clip(summary, Math.max(8, room)) : "";
      const out: L[] = [
        styled(
          DEPTH.did,
          { text: `${mark} `, color: markColor },
          { text: verb, bold: true, color: i.ok === false ? "red" : undefined },
          ...(shown
            ? i.name === "shell"
              ? [{ text: " " }, ...highlightCommand(shown)]
              : [{ text: ` ${shown}`, color: "cyan" as const }]
            : []),
        ),
      ];

      const body = i.running ? i.output : i.result;
      if (body?.trim()) {
        const dw = measureAt(DEPTH.detail, term);
        const { lines, hidden } = outputLines(body);
        // While running, the tail is what is happening; once finished, the
        // head is what happened.
        const shown = i.running ? lines.slice(-5) : lines;
        shown.forEach((l, n) => {
          out.push(
            styled(
              DEPTH.detail,
              { text: n === 0 ? "\u2514 " : "  ", dim: true },
              { text: clip(l, dw - 2), dim: true },
            ),
          );
        });
        if (!i.running && hidden > 0) {
          out.push({ text: `  \u2026 +${hidden} lines`, depth: DEPTH.detail, dim: true });
        }
      }
      return out;
    }

    case "error":
      return wrap(i.text, measureAt(DEPTH.did, term) - 2).map((t, n) => ({
        text: (n === 0 ? "\u2717 " : "  ") + t,
        depth: DEPTH.did,
        color: "red" as const,
      }));

    case "compaction":
      return [{
        text: clip(`\u22ef compacted ${i.dropped} events \u2014 ${i.summary}`, measureAt(DEPTH.did, term)),
        depth: DEPTH.did,
        dim: true,
        color: "yellow" as const,
      }];
  }
}
