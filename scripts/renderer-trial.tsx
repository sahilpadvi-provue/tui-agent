/**
 * The real App, with its real chrome, narrowed, through one renderer.
 *
 * This is the experiment that separates a fix from an avoidance. The composer
 * draws two rules the width of the terminal and the footer is split to its
 * right edge; those full-width lines are exactly what leaks under Ink. A
 * renderer that does not draw them cannot ghost, and proves nothing.
 *
 * One arm per process, because the swap is a Bun resolver and a resolver is
 * process-wide. `scripts/renderer-trial.ts` spawns both.
 */
import React from "react";
import { render as inkRender } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { Term } from "./vt.ts";

const INK = process.argv.includes("--ink");
const ROWS = 24;
const WIDTHS = [92, 84, 76, 68];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const term = new Term(100, ROWS);
const stdout: any = Object.assign(
  new Writable({ write(c, _e, cb) { term.write(String(c)); cb(); return true; } }),
  { columns: 100, rows: ROWS, isTTY: true },
);
const stdin: any = Object.assign(new PassThrough(), {
  isTTY: true, setRawMode() {}, ref() {}, unref() {},
});

const bus = new EventBus();
const view = (
  <App bus={bus} cwd="/tmp/demo" model="qwen3:8b" version="0.1.0" backend="ollama"
       sandbox="seatbelt" branch="main" busy={true}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />
);

// Our own mount() takes no options -- it is the app entry point, not a
// harness -- so the control arm drives Ink directly, the way every other gate
// in scripts/ does.
const app = INK
  ? inkRender(view, {
      stdout, stdin, patchConsole: false,
      incrementalRendering: true, exitOnCtrlC: false, maxFps: 60,
    })
  : mount(view, { stdout, stdin } as never);

const e = (x: any) => bus.emit({ sessionId: "s", ...x });
e({ type: "message.started", id: "u0", role: "user" });
e({ type: "message.completed", id: "u0", text: "add a health endpoint" });
e({ type: "reasoning.started", id: "r0" });
await wait(180);

const rules = () => term.visible().filter((l) => /^─{6,}$/.test(l.trim())).length;
const before = rules();

for (const cols of WIDTHS) {
  term.resize(cols);
  stdout.columns = cols;
  stdout.emit("resize");
  await wait(120);
}

for (const k of ["h", "i", "\x1b[200~a\rb\rc\x1b[201~"]) { stdin.write(k); await wait(80); }
await wait(160);

const screen = term.visible();
console.log(JSON.stringify({
  rulesBefore: before,
  rulesAfter: rules(),
  splitFooter: screen.some((l) => /qwen3:8b.*\s{6,}.*0↑/.test(l)),
  composer: screen.some((l) => l.includes("›")),
  typed: screen.some((l) => l.includes("hi")),
  chip: screen.some((l) => l.includes("[Pasted text #1 +3 lines]")),
}));
app.unmount();
process.exit(0);
