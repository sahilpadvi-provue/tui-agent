/**
 * The whole UI under a streamed answer, reported the way bench/app-bench.tsx
 * in the infinity repo reports it, so the two designs can be put side by side.
 *
 * Not a replacement for bench.tsx. That one builds a 500-message backlog and
 * is the gate on render cost staying flat; this one streams into an empty
 * transcript and exists to be compared against a renderer that commits settled
 * rows to the terminal's scrollback and redraws only a footer. The difference
 * between the two numbers is the difference between the designs, which is the
 * thing worth knowing.
 */
import React from "react";
import { Writable, PassThrough } from "node:stream";
import { writeSync } from "node:fs";
import { mount } from "../src/ui/primitives.tsx";
import { cellsBackend } from "../src/ui/backends/cells.tsx";
import { inkBackend } from "../src/ui/backends/ink.tsx";
import type { Backend } from "../src/ui/backend.ts";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { dark } from "../src/theme/index.ts";

const WIDTH = 100, HEIGHT = 40;
const TICKS = Number(process.env.TICKS ?? 2000);
const MODE = process.env.MODE ?? "burst";
const name = process.env.BACKEND ?? "cells";
const backend: Backend = name === "ink" ? inkBackend : cellsBackend;

let bytes = 0, frames = 0, firstByteSent = false;
let waiting: (() => void) | null = null;
let dropped = 0;
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

const wire = () => new Promise<void>((resolve) => {
  const timer = setTimeout(() => { waiting = null; dropped++; resolve(); }, 250);
  waiting = () => { clearTimeout(timer); resolve(); };
});

const bus = new EventBus();
const app = mount(
  <App theme={dark} bus={bus} cwd="/tmp/bench" model="bench" version="0.1.0"
       backend="ollama" sandbox="seatbelt" branch="main" busy={true}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { backend, stdout: stdout as any, stdin: stdin as any, onRender: () => { frames++; } },
);

const emit = (e: Record<string, unknown>) => bus.emit({ sessionId: "bench", ...e } as never);

await new Promise((r) => setTimeout(r, 120));
const bytesAfterFirst = bytes, framesAfterFirst = frames;

emit({ type: "message.started", id: "stream", role: "assistant" });
const lat: number[] = [];
const streamStart = performance.now();
for (let i = 0; i < TICKS; i++) {
  const t = performance.now();
  emit({ type: "message.delta", id: "stream", text: "tok " });
  if (MODE === "paced") await wire();
  lat.push(performance.now() - t);
  if (MODE === "burst" && i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
}
await new Promise((r) => setTimeout(r, 300));
const streamMs = performance.now() - streamStart;

const heapMb = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
const rssMb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
app.unmount();
await app.waitUntilExit();

lat.sort((a, b) => a - b);
const q = (p: number) =>
  lat.length === 0 ? 0 : Number(lat[Math.floor(lat.length * p)]!.toFixed(4));
writeSync(2, `RESULT ${JSON.stringify({
  backend: `${name}-app`, mode: MODE,
  firstPaintBytes: bytesAfterFirst,
  ticks: TICKS,
  ticksPerSec: Math.round(TICKS / (streamMs / 1000)),
  p50: q(0.5), p95: q(0.95), p99: q(0.99),
  max: lat.length === 0 ? 0 : Number(lat.at(-1)!.toFixed(3)),
  frames: frames - framesAfterFirst,
  bytes: bytes - bytesAfterFirst,
  dropped, heapMb, rssMb,
})}\n`);
process.exit(0);
