/**
 * The renderer does not ghost when the terminal narrows.
 *
 * Asserting this needs a terminal, because the bug is a terminal effect: a
 * line wider than the new width becomes two rows, and a renderer that erases
 * by line count leaves the surplus behind. So this carries a small VT model --
 * enough to hold rows, scroll, reflow on resize, and answer "what is on
 * screen now".
 *
 * `scripts/reflow-check.tsx` guards the layout rule that keeps Ink usable.
 * This guards the renderer that would make the rule unnecessary.
 */

import React from "react";
import { render, Box, Text } from "ink";
import { PassThrough, Writable } from "node:stream";
import { paint } from "../src/ui/render/screen.ts";
import { renderFrame } from "../src/ui/render/diff.ts";
import { BLANK, GUTTER, STEP, styled, type Line } from "../src/ui/layout.ts";
import { Term } from "./vt.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** A live frame shaped like the real one: a reasoning line over full-width chrome. */
function frame(term: number, thought: string): Line[] {
  return [
    styled(1, { text: thought, dim: true }),
    BLANK,
    styled(1, { text: "· working  20s · esc to interrupt", dim: true }),
    { text: "", rule: true, width: term },
    styled(0, { text: "› type to queue the next instruction", dim: true }),
    { text: "", rule: true, width: term },
    styled(0, { text: `qwen3:8b  ·  demo  ·  ${"x".repeat(term - 30)}`, dim: true }),
  ];
}

const ROWS = 24;
const term = new Term(100, ROWS);
let prev = null as ReturnType<typeof paint> | null;

const push = (cols: number, lines: Line[]) => {
  const next = paint(lines, cols);
  term.write(renderFrame(prev, next, ROWS));
  prev = next;
};

push(100, frame(100, "thinking…"));
check("first frame draws the live region", term.visible().some((l) => l.includes("thinking…")));

// Four narrowing steps, the way dragging a window produces them. Reflow and
// redraw are counted apart: a terminal re-wrapping its own screen can push
// rows into scrollback before the renderer is called at all, and that is not
// something any renderer can take back.
let byReflow = 0;
let byRender = 0;
const thinking = (ls: string[]) => ls.filter((l) => l.includes("thinking…")).length;

for (const cols of [92, 84, 76, 68]) {
  const start = thinking(term.scrollback);
  term.resize(cols);
  byReflow += thinking(term.scrollback) - start;

  const afterReflow = thinking(term.scrollback);
  push(cols, frame(cols, "thinking…"));
  byRender += thinking(term.scrollback) - afterReflow;
}

const onScreen = thinking(term.visible());
check("one 'thinking' on screen after four narrowings", onScreen === 1, `found ${onScreen}`);
check("the renderer pushes nothing into scrollback", byRender === 0, `pushed ${byRender}`);
check("the frame is intact, not scrolled away",
  term.visible().filter((l) => l.includes("esc to interrupt")).length === 1);

console.log(`     (the terminal's own reflow moved ${byReflow} into scrollback; unreachable by anyone)`);

// The live region redrawing in place must not grow the frame.
const before = term.visible().filter(Boolean).length;
push(68, frame(68, "thought for 966 chars"));
const after = term.visible().filter(Boolean).length;
check("redraw in place keeps the same row count", before === after, `${before} -> ${after}`);
check("the redraw replaced the line", !term.visible().some((l) => l.includes("thinking…")));

/**
 * The control arm.
 *
 * Without it this script only shows that the renderer passes a test written
 * beside it. Ink is driven through the same frames, the same narrowings and
 * the same terminal, so the number below is the bug being fixed rather than a
 * claim about it.
 */
const inkTerm = new Term(100, ROWS);
const stdout: any = Object.assign(
  new Writable({ write(c, _e, cb) { inkTerm.write(String(c)); cb(); return true; } }),
  { columns: 100, rows: ROWS, isTTY: true },
);
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

/** Geometry only: the ghosting is about row widths, not about colour. */
function lineString(l: Line, cols: number): string {
  if (l.rule) return "\u2500".repeat(Math.min(cols, l.width ?? cols));
  return " ".repeat(GUTTER + (l.depth ?? 0) * STEP) + l.text;
}

function InkFrame({ cols }: { cols: number }) {
  return (
    <Box flexDirection="column">
      {frame(cols, "thinking\u2026").map((l, i) => (
        <Text key={i}>{lineString(l, cols) || " "}</Text>
      ))}
    </Box>
  );
}

const app = render(<InkFrame cols={100} />, {
  stdout, stdin: stdin as any, patchConsole: false,
  incrementalRendering: true, exitOnCtrlC: false, maxFps: 60,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(120);
for (const cols of [92, 84, 76, 68]) {
  inkTerm.resize(cols);
  stdout.columns = cols;
  app.rerender(<InkFrame cols={cols} />);
  stdout.emit("resize");
  await wait(120);
}
app.unmount();

const inkOnScreen = inkTerm.visible().filter((l) => l.includes("thinking\u2026")).length;
console.log(`\n     control: Ink leaves ${inkOnScreen} on screen under the same four narrowings`);
check("the renderer beats Ink on the same input", onScreen < inkOnScreen,
  `ours ${onScreen}, ink ${inkOnScreen}`);

process.exit(failures === 0 ? 0 : 1);
