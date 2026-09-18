/**
 * Renderer cost on one screen, for comparison against a renderer that is not
 * behind `Backend` at all.
 *
 * `bench.tsx` measures the app: 500 messages, the view model, the viewport.
 * This measures the renderer alone, on a scene small enough that no backend
 * gets to win by clipping -- 34 body rows and a 6-row footer, exactly one
 * 100x40 screen, which is what OpenTUI's alternate-screen mode draws and all
 * a cell diff has to reach. Anything taller and the two are answering
 * different questions.
 *
 * Two modes, because one number cannot hold both halves of the answer.
 *
 * burst: push every update as fast as the loop will go and let the renderer
 * coalesce. That is what streaming a model's tokens looks like, and the
 * interesting figure is how few frames and bytes a renderer needs to keep up.
 *
 * paced: wait for each update to reach the wire before sending the next, so
 * every tick is one painted frame and the latency is the whole path --
 * reconcile, layout, diff, write. The wait is on bytes arriving at stdout
 * rather than on any renderer's own frame callback, because that is the one
 * signal all three share and it cannot be satisfied by a frame that was
 * already coming.
 */
import React, { useEffect, useState } from "react";
import { Writable, PassThrough } from "node:stream";
import { writeSync } from "node:fs";
import { Stack, Label, mount } from "../src/ui/primitives.tsx";
import { cellsBackend } from "../src/ui/backends/cells.tsx";
import { inkBackend } from "../src/ui/backends/ink.tsx";
import type { Backend } from "../src/ui/backend.ts";
import { slot } from "../src/theme/index.ts";

const cyan = slot("cyan");

const WIDTH = 100, HEIGHT = 40, BODY = 34, FOOTER = 6;
const TICKS = Number(process.env.TICKS ?? 2000);
const MODE = process.env.MODE ?? "burst";
const name = process.env.BACKEND ?? "cells";
const backend: Backend = name === "ink" ? inkBackend : cellsBackend;

let bytes = 0, frames = 0, firstByteSent = false;
let waiting: (() => void) | null = null;
const stdout = Object.assign(
  new Writable({
    write(c, _e, cb) {
      bytes += c.length;
      if (!firstByteSent) { firstByteSent = true; writeSync(2, `FIRSTBYTE ${Date.now()}\n`); }
      const w = waiting; waiting = null; w?.();
      cb(); return true;
    },
  }),
  { columns: WIDTH, rows: HEIGHT, isTTY: true },
);
const stdin = Object.assign(new PassThrough(), {
  isTTY: true, setRawMode() {}, ref() {}, unref() {},
});

let dropped = 0;
const wire = () => new Promise<void>((resolve) => {
  const timer = setTimeout(() => { waiting = null; dropped++; resolve(); }, 250);
  waiting = () => { clearTimeout(timer); resolve(); };
});

type Frame = { body: string[]; footer: string[] };
let push: ((next: Frame) => void) | null = null;

function Scene(initial: Frame) {
  const [{ body, footer }, setFrame] = useState<Frame>(initial);
  useEffect(() => { push = setFrame; }, []);
  return (
    <Stack direction="column">
      {body.map((line, i) => (
        <Label key={i} color={i % 3 === 0 ? cyan : undefined} bold={i % 7 === 0}>
          {line}
        </Label>
      ))}
      <Stack direction="column">
        {footer.map((line, i) => <Label key={i} dim={i > 0}>{line}</Label>)}
      </Stack>
    </Stack>
  );
}

const body = Array.from({ length: BODY }, (_, i) =>
  `line ${i}: ${"lorem ipsum ".repeat(5)}`.slice(0, WIDTH - 1));
const footer = Array.from({ length: FOOTER }, (_, i) => `footer ${i}`);

const t0 = performance.now();
const app = mount(<Scene body={body} footer={footer} />, {
  backend, stdout: stdout as any, stdin: stdin as any, onRender: () => { frames++; },
});
await new Promise((r) => setTimeout(r, 120));
const ttfpMs = performance.now() - t0;
writeSync(2, `FIRSTPAINT ${Date.now()}\n`);

const framesAfterFirst = frames, bytesAfterFirst = bytes;
let tail = "";
const lat: number[] = [];
const streamStart = performance.now();
for (let i = 0; i < TICKS; i++) {
  tail += "tok ";
  if (tail.length > WIDTH - 12) { body.shift(); body.push(""); tail = ""; }
  const next = body.slice();
  next[next.length - 1] = `line: ${tail}`;
  const t = performance.now();
  push!({ body: next, footer: [...footer.slice(0, FOOTER - 1), `tick ${i}`] });
  if (MODE === "paced") await wire();
  lat.push(performance.now() - t);
  if (MODE === "burst" && i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
}
await new Promise((r) => setTimeout(r, 300));
const streamMs = performance.now() - streamStart;

app.unmount();
await app.waitUntilExit();

lat.sort((a, b) => a - b);
const q = (p: number) => Number(lat[Math.floor(lat.length * p)]!.toFixed(4));
writeSync(2, `RESULT ${JSON.stringify({
  backend: name, mode: MODE,
  ttfpMs: Number(ttfpMs.toFixed(1)),
  firstPaintBytes: bytesAfterFirst,
  ticks: TICKS,
  ticksPerSec: Math.round(TICKS / (streamMs / 1000)),
  p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Number(lat.at(-1)!.toFixed(3)),
  frames: frames - framesAfterFirst,
  bytes: bytes - bytesAfterFirst,
  dropped,
  heapMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
  rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
})}\n`);
process.exit(0);
