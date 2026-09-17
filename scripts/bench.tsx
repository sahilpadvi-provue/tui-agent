/** Stage 2 gate: render cost on a long transcript under streaming. */
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

const MESSAGES = Number(process.env.MESSAGES ?? 500);
const TOKENS = Number(process.env.TOKENS ?? 2000);

let bytes = 0;
let frames = 0;
const stdout = Object.assign(
  new Writable({ write(c, _e, cb) { bytes += c.length; cb(); return true; } }),
  { columns: 100, rows: 40, isTTY: true },
);
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const bus = new EventBus();
const app = render(
  <App bus={bus} cwd="/tmp/bench" model="bench" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={true}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout: stdout as any, stdin: stdin as any, patchConsole: false, incrementalRendering: true,
    maxFps: 60, onRender: () => { frames++; } },
);

const emit = (e: any) => bus.emit({ sessionId: "bench", ...e });

// Build the backlog.
const buildStart = performance.now();
for (let i = 0; i < MESSAGES; i++) {
  emit({ type: "message.started", id: `a${i}`, role: "assistant" });
  emit({ type: "message.completed", id: `a${i}`, text: `message ${i}: ${"lorem ipsum ".repeat(6)}` });
}
await new Promise((r) => setTimeout(r, 300));
const buildMs = performance.now() - buildStart;
const framesAfterBuild = frames, bytesAfterBuild = bytes;

// Stream tokens into that backlog and measure per-delta cost.
emit({ type: "message.started", id: "stream", role: "assistant" });
const lat: number[] = [];
const streamStart = performance.now();
for (let i = 0; i < TOKENS; i++) {
  const t0 = performance.now();
  emit({ type: "message.delta", id: "stream", text: "tok " });
  lat.push(performance.now() - t0);
  if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
}
await new Promise((r) => setTimeout(r, 400));
const streamMs = performance.now() - streamStart;

app.unmount();
await app.waitUntilExit();

lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.floor(lat.length * q)]!.toFixed(3);
const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

console.log(`transcript:     ${MESSAGES} messages built in ${buildMs.toFixed(0)}ms (${framesAfterBuild} frames, ${(bytesAfterBuild / 1024).toFixed(0)}KB)`);
console.log(`streaming:      ${TOKENS} deltas in ${streamMs.toFixed(0)}ms  (${(TOKENS / (streamMs / 1000)).toFixed(0)} deltas/sec)`);
console.log(`dispatch p50:   ${p(0.5)}ms   p95: ${p(0.95)}ms   p99: ${p(0.99)}ms   max: ${lat.at(-1)!.toFixed(2)}ms`);
console.log(`frames total:   ${frames}   stdout: ${(bytes / 1024 / 1024).toFixed(2)}MB`);
console.log(`heap after:     ${heap}MB`);
