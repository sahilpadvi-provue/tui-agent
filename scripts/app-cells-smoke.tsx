/** The real App, unmodified, rendering through the cell renderer. */
import React from "react";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { Term } from "./vt.ts";
import { dark } from "../src/theme/index.ts";

// Escape sequences carry the row boundaries, so the output has to be played
// into a terminal to be read back. Stripping them concatenates every row.
const term = new Term(90, 20);
const stdout: any = Object.assign(
  new Writable({ write(c, _e, cb) { term.write(String(c)); cb(); return true; } }),
  { columns: 90, rows: 20, isTTY: true },
);
const stdin: any = Object.assign(new PassThrough(), {
  isTTY: true, setRawMode() {}, ref() {}, unref() {},
});

const bus = new EventBus();
const app = mount(
  <App theme={dark} bus={bus} cwd="/tmp/demo" model="qwen3:8b" version="0.1.0" backend="ollama"
       sandbox="seatbelt" branch="main" busy={true}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout, stdin },
);

const e = (x: any) => bus.emit({ sessionId: "s", ...x });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

e({ type: "message.started", id: "u0", role: "user" });
e({ type: "message.completed", id: "u0", text: "add a health endpoint" });
e({ type: "tool.started", callId: "c0", name: "shell" });
e({ type: "tool.ended", callId: "c0", args: { command: "npm test" } });
e({ type: "tool.result", callId: "c0", ok: true, result: "3 passing" });
// One finished and one still running, because the live line is drawn in place
// rather than scrolled: completing the only reasoning item overwrites the very
// row the next check is looking for.
e({ type: "reasoning.started", id: "r1" });
await wait(120);
e({ type: "reasoning.completed", id: "r1", payload: { raw: {}, text: "some reasoning" } });
e({ type: "reasoning.started", id: "r0" });
await wait(150);
app.unmount();

const rows = [...term.scrollback, ...term.visible()].filter((s) => s.trim());

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

check("the banner rendered", rows.some((r) => r.includes("tui-agent")), rows[0] ?? "");
check("the request rendered", rows.some((r) => r.includes("add a health endpoint")));
check("the tool call rendered", rows.some((r) => r.includes("npm test")));
check("the live reasoning line rendered", rows.some((r) => r.includes("thinking")));
// A duration, not a character count: what the reader spent, not what the model
// produced. Matched as a shape so the assertion does not pin the wall clock.
check(
  "finished reasoning reports how long it took",
  rows.some((r) => /thought for \d+(\.\d)?s/.test(r)),
  rows.find((r) => r.includes("thought for")) ?? "no `thought for` line at all",
);
check("the composer rendered", rows.some((r) => r.includes("type to queue")));
check("the footer rendered", rows.some((r) => r.includes("qwen3:8b")));

if (failures > 0 || process.argv.includes("--show")) console.log("\n" + rows.slice(0, 30).map((r) => `  | ${r}`).join("\n"));
process.exit(failures === 0 ? 0 : 1);
