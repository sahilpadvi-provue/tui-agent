/**
 * The frame cap coalesces a stream without delaying a keystroke.
 *
 * Those are the two halves of `FRAME_MS` in the cell renderer and they pull
 * against each other: a cap that waits out its budget before painting would
 * coalesce beautifully and put 16ms between a key and the character. This
 * asserts both, because passing one half is what a wrong implementation
 * looks like.
 *
 * Ink is the control on the second half only. It caps too, so it is the
 * evidence that the coalescing number is achievable rather than a bug, and it
 * is not held to the first: how fast Ink answers a keystroke is not this
 * repo's claim to make.
 */
import React, { useState } from "react";
import { Writable, PassThrough } from "node:stream";
import { Stack, Label, mount, useKeys } from "../src/ui/primitives.tsx";
import { cellsBackend, FRAME_MS } from "../src/ui/backends/cells.tsx";
import { inkBackend } from "../src/ui/backends/ink.tsx";
import type { Backend } from "../src/ui/backend.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const KEYS = 40;
/**
 * Derived from the thing it guards, not a number of its own: a deferred paint
 * lands at the far end of the budget, so anything under half of it did not
 * wait. A fixed threshold drifts out of meaning the moment `FRAME_MS` moves,
 * and a tight one fails on scheduler noise -- 5ms failed 1 run in 10 at a
 * measured p50 of 0.83ms, which is the gate reporting the machine.
 */
const KEY_BUDGET_MS = FRAME_MS / 2;
const UPDATES = 600;

function fakeTty() {
  let waiting: (() => void) | null = null;
  let frames = 0;
  const stdout = Object.assign(
    new Writable({
      write(_c, _e, cb) {
        frames++;
        const w = waiting; waiting = null; w?.();
        cb(); return true;
      },
    }),
    { columns: 80, rows: 24, isTTY: true },
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  return {
    stdout: stdout as any, stdin: stdin as any,
    get frames() { return frames; },
    wire: () => new Promise<void>((r) => { waiting = r; }),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keystrokes on an idle screen, each one arriving long after the last paint. */
async function keyLatency(backend: Backend) {
  const tty = fakeTty();
  function Composer() {
    const [text, setText] = useState("");
    useKeys((char) => setText((t) => t + char));
    return <Stack direction="column"><Label>{`> ${text}`}</Label></Stack>;
  }
  const app = mount(<Composer />, { backend, ...tty });
  await wait(200);

  const lat: number[] = [];
  for (let i = 0; i < KEYS; i++) {
    await wait(40);
    const seen = tty.wire();
    const t = performance.now();
    tty.stdin.write("x");
    await seen;
    lat.push(performance.now() - t);
  }
  app.unmount();
  await app.waitUntilExit();
  lat.sort((a, b) => a - b);
  return { p50: lat[Math.floor(KEYS * 0.5)]!, p95: lat[Math.floor(KEYS * 0.95)]! };
}

/** A stream pushed as fast as the loop allows, which is what a model's tokens do. */
async function burstFrames(backend: Backend) {
  const tty = fakeTty();
  let push: ((n: number) => void) | null = null;
  function Counter() {
    const [n, setN] = useState(0);
    React.useEffect(() => { push = setN; }, []);
    return <Stack direction="column"><Label>{`count ${n}`}</Label></Stack>;
  }
  const app = mount(<Counter />, { backend, ...tty });
  await wait(200);

  const before = tty.frames;
  const start = performance.now();
  for (let i = 1; i <= UPDATES; i++) {
    push!(i);
    if (i % 25 === 0) await wait(0);
  }
  await wait(120);
  const elapsed = performance.now() - start;
  const painted = tty.frames - before;
  app.unmount();
  await app.waitUntilExit();
  // What 60fps could have shown over the same wall clock, plus the trailing frame.
  return { painted, ceiling: Math.ceil(elapsed / 16) + 2 };
}

const key = await keyLatency(cellsBackend);
check(
  "a keystroke on an idle screen is not held for the frame budget",
  key.p95 < KEY_BUDGET_MS,
  `p50 ${key.p50.toFixed(3)}ms p95 ${key.p95.toFixed(3)}ms, budget ${KEY_BUDGET_MS}ms of ${FRAME_MS}ms`,
);

const cells = await burstFrames(cellsBackend);
check(
  "a burst is coalesced to what the terminal could show",
  cells.painted <= cells.ceiling,
  `${cells.painted} frames for ${UPDATES} updates, ceiling ${cells.ceiling}`,
);

const ink = await burstFrames(inkBackend);
check(
  "     control: Ink coalesces the same burst too",
  ink.painted <= ink.ceiling,
  `${ink.painted} frames, ceiling ${ink.ceiling}`,
);

console.log(failures === 0
  ? "\nthe cap coalesces a stream and stays out of a keystroke's way"
  : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
