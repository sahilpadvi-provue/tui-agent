/**
 * What moves, when, and what stops.
 *
 * Asserts the screen and the timer, never a render count. Every phase derives
 * from one counter, so a watcher woken early reads an unchanged snapshot and
 * `useSyncExternalStore` bails out without rendering -- which means a test
 * phrased as "it renders once per blink" passes on a clock that ignores its
 * interval entirely. The observable properties are what is drawn, and whether
 * a timer exists at all.
 *
 * Runs itself again with NO_MOTION set, because the suppression is read once
 * at module load and cannot be toggled in-process.
 */

import React from "react";
import { mount } from "../src/ui/primitives.tsx";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { clockRunning } from "../src/ui/clock.ts";
import { screen } from "./vt.ts";
import { dark } from "../src/theme/index.ts";

const suppressed = (process.env["NO_MOTION"] ?? "") !== "";

/**
 * The part of the working row that does not change.
 *
 * Its verb is chosen per turn, so matching the word would make this gate
 * depend on which one came up -- green on one run and confused on the next.
 */
const MARK = "esc to interrupt";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

type Seen = {
  composer: Set<string>;
  working: Set<string>;
  /** One signature per sample of the bytes written since the last one. The
   *  shimmer changes colour and not text, so it is invisible to `lines()`. */
  repaints: string[];
  timer: boolean[];
};

async function observe(
  busy: boolean,
  drive: (e: (x: Record<string, unknown>) => void) => void,
  samples: number,
): Promise<Seen> {
  const view = screen(80, 24);
  const bus = new EventBus();
  const app = mount(
    <App theme={dark} bus={bus} cwd="/p" model="m" version="0" backend="b" sandbox="off" branch="main"
         busy={busy} onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}}
         onPermission={() => {}} />,
    { stdout: view.stdout, stdin: view.stdin },
  );
  drive((x) => bus.emit({ sessionId: "s", ...x } as never));
  await new Promise((r) => setTimeout(r, 140));

  const seen: Seen = { composer: new Set(), working: new Set(), repaints: [], timer: [] };
  let read = view.raw().length;
  for (let i = 0; i < samples; i++) {
    const rows = view.lines();
    seen.composer.add((rows.filter((l) => l.includes("› ")).pop() ?? "").trimEnd());
    seen.working.add((rows.find((l) => l.includes(MARK)) ?? "").trimEnd());
    const raw = view.raw();
    const chunk = raw.slice(read);
    read = raw.length;
    // Per-character styling means a styled word is never contiguous in the
    // buffer: the shimmer writes an SGR run between every letter, so matching
    // on the raw bytes finds nothing. src/ui/README.md warns about exactly this.
    if (chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").includes(MARK)) {
      seen.repaints.push([...chunk.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1]).join(","));
    }
    seen.timer.push(clockRunning());
    await new Promise((r) => setTimeout(r, 80));
  }
  app.unmount();
  await new Promise((r) => setTimeout(r, 60));
  seen.timer.push(clockRunning());
  return seen;
}

const nothing = () => {};
const aTurn = (e: (x: Record<string, unknown>) => void) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "go" });
};
const aPrompt = (e: (x: Record<string, unknown>) => void) => {
  aTurn(e);
  e({ type: "tool.started", callId: "c", name: "shell" });
  e({ type: "tool.ended", callId: "c", args: { command: "rm -r dist" } });
  e({ type: "permission.requested", requestId: "p", callId: "c", tool: "shell",
      blastRadius: { writes: ["/p/dist"], network: true, command: "rm -r dist" } });
};

const idle = await observe(false, nothing, 18);
// Long enough for the elapsed clock to tick at least once. With motion
// suppressed that is the only thing that repaints the working row, and
// without a repaint the "never sweeps" assertion below would be vacuous.
const busy = await observe(true, aTurn, 16);
const pending = await observe(true, aPrompt, 16);

if (suppressed) {
  check("NO_MOTION: the working row is repainted at all",
    busy.repaints.length > 0, "otherwise the next assertion passes vacuously");
  check("NO_MOTION: but never with a different sweep",
    new Set(busy.repaints).size <= 1, `${new Set(busy.repaints).size} distinct repaints`);
  check("NO_MOTION: and only at the clock's rate, not the shimmer's",
    busy.repaints.length <= 3, `${busy.repaints.length} repaints in 1.3s`);
  check("NO_MOTION: an idle screen has no timer at all", !idle.timer.some(Boolean),
    "suppression is a decision not to subscribe, so there is nothing left to stop");
  check("NO_MOTION: the working row is still drawn",
    [...busy.working][0]?.includes(MARK) === true,
    "the elapsed clock is not decoration and must keep counting");
  process.exit(failures === 0 ? 0 : 1);
}

check("idle: nothing on screen moves", idle.composer.size === 1, `${idle.composer.size} distinct`);
check("idle: and there is no timer to move it",
  !idle.timer.some(Boolean),
  "a blinking caret was built here and removed: a timer that never stops costs a "
  + "repaint of the whole transcript every half second, and a caret carries nothing "
  + "a static one does not");
check("idle: the working row is absent", [...idle.working].every((l) => l === ""));

check("busy: the shimmer sweeps", new Set(busy.repaints).size > 1,
  `${new Set(busy.repaints).size} distinct repaints of the working row`);
check("busy: the caret is still", busy.composer.size === 1,
  "two things moving puts motion in the corner of the eye for the length of a turn");

check("a prompt sweeps once and then stops",
  pending.timer.some(Boolean) && !pending.timer[pending.timer.length - 2],
  pending.timer.map((t) => (t ? "t" : "-")).join(""));
check("and the screen is still while the user decides", pending.composer.size === 1);
check("the timer is gone after unmount",
  !idle.timer.at(-1) && !busy.timer.at(-1) && !pending.timer.at(-1));

const { spawnSync } = await import("node:child_process");
console.log("\n── with NO_MOTION set ──");
const again = spawnSync(process.execPath, ["run", import.meta.filename], {
  env: { ...process.env, NO_MOTION: "1" }, encoding: "utf8",
});
process.stdout.write(again.stdout ?? "");
if (again.status !== 0) failures++;

process.exit(failures === 0 ? 0 : 1);
