import React, { useEffect, useMemo, useReducer, useState } from "react";
import { Stack, Label, Settled, useKeys, useStdout, type Color } from "./primitives.tsx";
import { reduce, initialState, type ViewItem } from "./model.ts";
import { Markdown } from "./markdown.tsx";
import { describeRadius } from "../permissions/policy.ts";
import type { EventBus } from "../core/bus.ts";
import type { PermissionDecision } from "../core/events.ts";

export type AppProps = {
  bus: EventBus;
  cwd: string;
  model: string;
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
export function App({ bus, cwd, model, onSubmit, onCancel, onPermission, busy }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [input, setInput] = useState("");
  const { stdout } = useStdout();

  // The only connection to the runtime: a subscription. No calls in, ever.
  useEffect(() => bus.on((e) => dispatch(e)), [bus]);

  useKeys((char, key) => {
    if (state.pending) {
      if (char === "y") onPermission({ kind: "allow", scope: "once" });
      else if (char === "a") onPermission({ kind: "allow", scope: "session" });
      else if (char === "n" || key.escape) onPermission({ kind: "deny", reason: "declined" });
      return;
    }
    if (key.escape || (key.ctrl && char === "c")) {
      if (busy) onCancel();
      return;
    }
    if (busy) return;

    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput("");
      onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const width = Math.max(40, (stdout?.columns ?? 80) - 2);

  // An item is settled once nothing can change it again. Settled items are
  // append-only; re-deriving this list must never reorder or drop entries.
  const settledCount = countSettled(state.items);
  const settled = useMemo(
    () => state.items.slice(0, settledCount).flatMap((i) => renderItem(i, width)),
    [settledCount, width, state.items],
  );
  const live = state.items.slice(settledCount).flatMap((i) => renderItem(i, width));

  return (
    <>
      <Settled items={settled} render={(line, i) => <Line key={i} line={line} />} />

      <Stack direction="column">
        {live.map((l, i) => (
          <Line key={`live-${i}`} line={l} />
        ))}

        {state.pending ? (
          <Stack direction="column" padX={1} border borderColor="yellow">
            <Label bold color="yellow">{`approve ${state.pending.tool}?`}</Label>
            <Label dim>{describeRadius(state.pending.radius)}</Label>
            <Label>{"[y] once   [a] all session   [n] deny"}</Label>
          </Stack>
        ) : (
          <Stack direction="row" padX={1} border borderColor={busy ? "gray" : "cyan"}>
            <Label color={busy ? "gray" : "cyan"}>{busy ? "… " : "› "}</Label>
            <Label>{busy ? "working… (esc to cancel)" : input + "▏"}</Label>
          </Stack>
        )}

        <Stack direction="row" padX={1}>
          <Label dim>{`${shorten(cwd, 44)}  ·  ${model}  ·  ${state.usage.input}↑ ${state.usage.output}↓`}</Label>
        </Stack>
      </Stack>
    </>
  );
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

type Line = { text: string; color?: Color; dim?: boolean; bold?: boolean; md?: boolean };

/** Assistant prose gets markdown; tool output and chrome stay literal. */
function Line({ line }: { line: Line }) {
  if (line.md) return <Markdown line={line.text} color={line.color} dim={line.dim} />;
  return (
    <Label color={line.color} dim={line.dim} bold={line.bold}>
      {line.text}
    </Label>
  );
}

function renderItem(i: ViewItem, width: number): Line[] {
  const w = Math.max(20, width - 4);
  switch (i.kind) {
    case "user":
      return [{ text: "" }, ...wrap(i.text, w).map((t) => ({ text: `› ${t}`, bold: true }))];
    case "assistant":
      return wrap(i.text, w).map((t) => ({ text: t, md: true }));
    case "reasoning":
      return [{ text: i.done ? `  thought for ${i.chars} chars` : `  thinking… ${i.chars}`, dim: true }];
    case "tool": {
      const mark = i.running ? "▸" : i.ok === false ? "✗" : "✓";
      const head = `  ${mark} ${i.name}${i.args ? ` ${compact(i.args)}` : ""}`;
      const out: Line[] = [{ text: truncate(head, w), color: i.ok === false ? "red" : "cyan" }];
      const body = i.running ? i.output : i.result;
      if (body) {
        const lines = body.split("\n").filter(Boolean);
        const shown = i.running ? lines.slice(-6) : lines.slice(0, 8);
        for (const l of shown) out.push({ text: `      ${truncate(l, w - 6)}`, dim: true });
        if (!i.running && lines.length > 8) {
          out.push({ text: `      … ${lines.length - 8} more lines`, dim: true });
        }
      }
      return out;
    }
    case "error":
      return [{ text: `  ✗ ${i.text}`, color: "red" }];
    case "compaction":
      return [{ text: `  ⋯ compacted ${i.dropped} events — ${truncate(i.summary, w - 20)}`, color: "yellow" }];
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + word).length > width) {
        out.push(line.trimEnd());
        line = "";
      }
      line += word + " ";
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\n/g, " ");
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

function compact(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function shorten(p: string, n: number): string {
  return p.length > n ? "…" + p.slice(-(n - 1)) : p;
}
