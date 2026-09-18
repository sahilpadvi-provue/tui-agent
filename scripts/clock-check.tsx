/**
 * One clock, and no clock at all when nothing is moving.
 *
 * The second half is the one that matters. A running timer re-renders on its
 * next tick and picks up whatever went wrong, so a screen with motion on it
 * looks correct whether or not a resize did any work -- which is why
 * `quiet-resize-check` asserts against a component with no timer, and why an
 * always-on frame loop would have made that gate structurally blind to the bug
 * it was written for. `docs/CONTEXT.md` records three wrong conclusions in one
 * session from measuring through a running shimmer.
 *
 * The app used to own two independent intervals, 90ms and 1000ms, producing
 * two commit streams.
 */
import React from "react";
import { spawnSync } from "node:child_process";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { clockRunning, usePhase, TICK_MS } from "../src/ui/clock.ts";
import { screen } from "./vt.ts";
import { Label, Stack } from "../src/ui/primitives.tsx";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mounts the app and counts the frames actually written. */
async function frames(busy: boolean, forMs: number) {
  const vt = screen(80, 24);
  let painted = 0;
  const app = mount(
    <App bus={new EventBus()} cwd="/tmp/demo" model="m" version="0" backend="b" sandbox="off"
         busy={busy} onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}}
         onPermission={() => {}} />,
    { stdout: vt.stdout, stdin: vt.stdin, onRender: () => { painted += 1; } },
  );
  await wait(160);
  const settled = painted;
  const running = clockRunning();
  await wait(forMs);
  const total = painted;
  app.unmount();
  await app.waitUntilExit();
  return { settled, total, running, after: clockRunning() };
}

// A child of this script with NO_MOTION set, because the rule is read once at
// module load and an env var cannot be changed after that from inside.
if (process.argv.includes("--frames")) {
  const r = await frames(true, 1000);
  console.log(JSON.stringify({ settled: r.settled, total: r.total, running: r.running }));
  process.exit(0);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- no timer when nothing moves -------------------------------------------

const quiet = await frames(false, 700);
check("an idle screen has no timer at all", quiet.running === false);
check("and it stops painting once it has settled",
  quiet.total === quiet.settled, `${quiet.settled} then ${quiet.total}`);

const busy = await frames(true, 700);
check("a busy screen has one", busy.running === true);
check("and it keeps painting", busy.total > busy.settled, `${busy.settled} then ${busy.total}`);
check("the timer is gone once the app unmounts", busy.after === false);

// Roughly 700ms of an 80ms shimmer. Bounded above as well as below: the point
// of one shared clock is that two animated things do not produce two streams.
const steps = Math.round(700 / TICK_MS);
check("a busy screen paints about once per tick, not twice",
  busy.total - busy.settled > steps / 2 && busy.total - busy.settled <= steps + 3,
  `${busy.total - busy.settled} frames in ~${steps} ticks`);

// ---- quantisation ----------------------------------------------------------
//
// Tested directly rather than through `App`, because the shimmer asks for one
// step and the elapsed clock reads the wall clock rather than its phase, so
// neither exercises an interval slower than the quantum. That is what anything
// the motion work adds next will be -- a caret blink is five or six steps.
//
// What this does NOT guard is the modulo in `advance`. Every phase derives
// from `ticks`, so a watcher woken early reads an unchanged snapshot and
// `useSyncExternalStore` bails out; notifying every watcher on every tick
// passes all of these. The modulo saves the wakeup, not the render, and
// nothing here can see the difference. Said plainly rather than left as
// implied coverage.

async function phaseRenders(everyMs: number, forMs: number) {
  const vt = screen(40, 8);
  let renders = 0;
  function Ticker() {
    const phase = usePhase(everyMs);
    renders += 1;
    return <Stack><Label>{`phase ${phase}`}</Label></Stack>;
  }
  const app = mount(<Ticker />, { stdout: vt.stdout, stdin: vt.stdin });
  await wait(120);
  const settled = renders;
  await wait(forMs);
  const total = renders;
  app.unmount();
  await app.waitUntilExit();
  return total - settled;
}

const window = 800;
const slow = await phaseRenders(400, window);
const fast = await phaseRenders(TICK_MS, window);
check("a watcher slower than the quantum renders on its own interval, not every tick",
  slow <= Math.round(window / 400) + 1, `${slow} renders in ${window}ms at 400ms`);
check("and a watcher at the quantum renders every tick",
  fast >= Math.round(window / TICK_MS) - 2, `${fast} renders in ${window}ms at ${TICK_MS}ms`);
check("so the slow one is not simply following the fast one", slow * 3 < fast,
  `${slow} vs ${fast}`);

// ---- reduced motion --------------------------------------------------------

const self = new URL(import.meta.url).pathname;
const run = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["run", self, "--frames"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as { settled: number; total: number; running: boolean };
  } catch {
    return null;
  }
};

const moving = run({});
const still = run({ NO_MOTION: "1" });
check("the child measured something in both arms", moving !== null && still !== null,
  JSON.stringify([moving, still]));

if (moving && still) {
  const movingFrames = moving.total - moving.settled;
  const stillFrames = still.total - still.settled;
  check("NO_MOTION stops the shimmer", stillFrames < movingFrames / 3,
    `${movingFrames} frames moving, ${stillFrames} suppressed`);
  // The elapsed clock is information, not decoration: a number that stops
  // counting is not calmer, it is broken, and a local model thinks for minutes.
  check("but the elapsed clock still runs", still.running === true && stillFrames >= 1,
    `running=${still.running} frames=${stillFrames}`);
}

// ---- any value suppresses --------------------------------------------------

const zero = run({ NO_MOTION: "0" });
check("NO_MOTION takes NO_COLOR's rule: any non-empty value suppresses",
  zero !== null && zero.total - zero.settled < 5, JSON.stringify(zero));
const empty = run({ NO_MOTION: "" });
check("and an empty value does not",
  empty !== null && empty.total - empty.settled > 5, JSON.stringify(empty));

console.log(failures === 0 ? "\none clock, and none when nothing moves" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
