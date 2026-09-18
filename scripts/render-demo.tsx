/**
 * Drive the renderer by hand, in a real terminal.
 *
 * `render-check.tsx` proves the arithmetic against a model terminal. This is
 * the other half: a session-shaped transcript that grows while you drag the
 * window, so the ghosting either happens in front of you or it does not.
 *
 *   bun run scripts/render-demo.tsx            our renderer
 *   bun run scripts/render-demo.tsx --ink      the same frames through Ink
 *   bun run scripts/render-demo.tsx --frames 4 non-interactive, for piping
 *
 * Run the two in one terminal, one after the other, and narrow the window a
 * few columns at a time during each.
 */

import React, { useEffect, useState } from "react";
import { render, Box, Text, Static } from "ink";
import { paint, type Screen } from "../src/ui/render/screen.ts";
import { renderFrame, HIDE_CURSOR, SHOW_CURSOR } from "../src/ui/render/diff.ts";
import { BLANK, DEPTH, GUTTER, STEP, styled, type Line } from "../src/ui/layout.ts";
import { rgb, slot } from "../src/theme/index.ts";

const useInk = process.argv.includes("--ink");
const frameArg = process.argv.indexOf("--frames");
const maxFrames = frameArg === -1 ? Infinity : Number(process.argv[frameArg + 1] ?? 4);

const cols = () => process.stdout.columns ?? 100;
const rows = () => process.stdout.rows ?? 24;

/**
 * Settled transcript, appended to over time. Append-only, exactly as the real
 * one is: these rows end up in the terminal's scrollback and can never be
 * rewritten.
 */
const settled: Line[] = [
  styled(DEPTH.said, { text: "› ", color: slot("cyan") }, { text: "add a health endpoint" }),
  BLANK,
];

const TOOLS = [
  ["Listed", "."],
  ["Read", "src/server.ts"],
  ["Ran", "npm test"],
  ["Edited", "src/routes.ts"],
  ["Read", "src/routes.ts"],
  ["Ran", "npm test -- --grep health"],
];

function advance(n: number): void {
  const tool = TOOLS[n % TOOLS.length]!;
  settled.push(
    { text: `thought for ${300 + n * 37} chars`, depth: DEPTH.did, dim: true },
    styled(
      DEPTH.did,
      { text: "✓ ", color: slot("green") },
      { text: tool[0]!, bold: true },
      { text: ` ${tool[1]!}`, color: slot("cyan") },
    ),
    { text: `└ ${"ok".padEnd(4)} ${n + 1} of many`, depth: DEPTH.detail, dim: true },
  );
}

/** The live region: what redraws every tick, and what used to leave ghosts. */
function live(term: number, tick: number): Line[] {
  return [
    { text: "thinking…", depth: DEPTH.did, dim: true },
    BLANK,
    styled(DEPTH.did, { text: "· ", color: slot("cyan") }, { text: `working  ${tick}s · esc to interrupt`, dim: true }),
    BLANK,
    styled(0, { text: "› ", color: slot("cyan") }, { text: "type to queue the next instruction", dim: true }),
    styled(0, { text: `qwen3:8b  ·  demo  ·  ${term} cols`, dim: true }),
  ];
}

if (useInk) {
  function Demo() {
    const [tick, setTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 700);
      return () => clearInterval(id);
    }, []);
    useEffect(() => {
      if (tick > 0 && tick % 3 === 0) advance(tick);
    }, [tick]);
    const pad = (l: Line) => " ".repeat(GUTTER + (l.depth ?? 0) * STEP) + l.text;
    return (
      <>
        <Static items={settled.slice()}>{(l, i) => <Text key={i}>{pad(l) || " "}</Text>}</Static>
        <Box flexDirection="column">
          {live(cols(), tick).map((l, i) => (
            <Text key={i}>{pad(l) || " "}</Text>
          ))}
        </Box>
      </>
    );
  }
  render(<Demo />, { incrementalRendering: true, exitOnCtrlC: true, maxFps: 60 });
} else {
  let prev: Screen | null = null;
  let tick = 0;
  let frames = 0;

  const draw = () => {
    const next = paint([...settled, ...live(cols(), tick)], cols());
    process.stdout.write(renderFrame(prev, next, rows()));
    prev = next;
  };

  const quit = () => {
    process.stdout.write(SHOW_CURSOR + "\n");
    process.exit(0);
  };

  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  // A width change invalidates every row index, so the next frame must be a
  // full repaint. renderFrame decides that from the grid, not from this event.
  process.stdout.on("resize", draw);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b) => {
      const k = b.toString();
      if (k === "q" || k === "\x03") quit();
    });
  }

  draw();
  const id = setInterval(() => {
    tick++;
    if (tick % 3 === 0) advance(tick);
    draw();
    if (++frames >= maxFrames) {
      clearInterval(id);
      quit();
    }
  }, 700);
}
