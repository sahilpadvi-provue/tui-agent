/**
 * Commands are the user acting on the session, and must behave like it:
 * visible in the transcript, recorded in the log, and invisible to the model.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { project } from "../src/core/projection.ts";
import { runCommand, COMMANDS, type CommandContext } from "../src/commands/registry.ts";
import type { AgentEvent } from "../src/core/events.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ws = mkdtempSync(join(tmpdir(), "cmd-"));
let switched = "";
let cleared = false;
let restored: number[] = [];

const history: AgentEvent[] = [
  { seq: 0, at: "", sessionId: "s", type: "message.started", id: "u", role: "user" },
  { seq: 1, at: "", sessionId: "s", type: "message.completed", id: "u", text: "do the thing" },
  { seq: 2, at: "", sessionId: "s", type: "tool.started", callId: "c", name: "read_file" },
  { seq: 3, at: "", sessionId: "s", type: "tool.ended", callId: "c", args: { path: "a.ts" } },
  { seq: 4, at: "", sessionId: "s", type: "tool.result", callId: "c", ok: true, result: "contents" },
  { seq: 5, at: "", sessionId: "s", type: "context.compacted", droppedSeqs: [4], summary: "read a.ts", reason: "budget" },
];

const ctx: CommandContext = {
  sessionId: "s", cwd: ws, history, model: "qwen3:8b",
  availableModels: async () => ["qwen3:8b", "qwen2.5-coder:7b"],
  setModel: (n) => { switched = n; },
  clear: () => { cleared = true; },
  restore: (s) => { restored = s; },
};

const help = await runCommand("/help", ctx);
check("/help lists every command", COMMANDS.every((c) => help.output.includes(`/${c.name}`)));

const context = await runCommand("/context", ctx);
check("/context reports what was hidden", /1 event|hid 1/.test(context.output), context.output.slice(0, 60));
check("/context offers the restore line", context.output.includes("/restore 4"), context.output.slice(-40));

await runCommand("/restore 4", ctx);
check("/restore passes the seqs through", restored.join() === "4", JSON.stringify(restored));

const models = await runCommand("/model", ctx);
check("/model asks the backend for the list", models.output.includes("qwen2.5-coder:7b"));
check("/model marks the current one", models.output.includes("• qwen3:8b"), models.output.slice(0, 40));

await runCommand("/model qwen2.5-coder:7b", ctx);
check("/model switches", switched === "qwen2.5-coder:7b", switched);

await runCommand("/clear", ctx);
check("/clear clears", cleared);

const bad = await runCommand("/nope", ctx);
check("an unknown command fails with the list", !bad.ok && bad.output.includes("/help"));

// The model must never see any of this.
const withCommand: AgentEvent[] = [
  ...history,
  { seq: 6, at: "", sessionId: "s", type: "local.invoked", command: "help", args: "", ok: true, output: "…" },
];
const { messages } = project(withCommand);
check("commands never enter the model's conversation",
  !messages.some((m) => m.text.includes("…")), JSON.stringify(messages.map((m) => m.text).slice(-2)));

// And they are visible on screen.
let buf = "";
const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
  { columns: 92, rows: 30, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const bus = new EventBus();
const app = render(
  <App bus={bus} cwd={ws} model="m" version="0" backend="b" sandbox="off" busy={false}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout: stdout as any, stdin: stdin as any, patchConsole: false },
);
await new Promise((r) => setTimeout(r, 100));
bus.emit({ sessionId: "s", type: "local.invoked", command: "checkpoints", args: "", ok: true, output: "  abc1234  before shell" });
await new Promise((r) => setTimeout(r, 150));
app.unmount();
await app.waitUntilExit();
const plain = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
check("a command is rendered in the transcript", plain.includes("/checkpoints"), plain.slice(-120));
check("its output is rendered", plain.includes("before shell"));

// ---------------------------------------------------------------------------
// The palette: typing a slash has to show what the commands are, not just
// their names. A list of bare names only helps someone who already knows them.
// ---------------------------------------------------------------------------

async function afterTyping(typed: string, width = 100) {
  let out = "";
  const so = Object.assign(new Writable({ write(c, _e, cb) { out += String(c); cb(); return true; } }),
    { columns: width, rows: 30, isTTY: true });
  const si = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const b = new EventBus();
  const a = render(
    <App bus={b} cwd={ws} model="m" version="0" backend="b" sandbox="off" busy={false}
         onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
    { stdout: so as any, stdin: si as any, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 90));
  for (const ch of typed) { si.write(ch); await new Promise((r) => setTimeout(r, 20)); }
  await new Promise((r) => setTimeout(r, 160));
  a.unmount();
  await a.waitUntilExit();
  const frames = out.split("\x1b[?2026h");
  return (frames[frames.length - 1] ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

const all = await afterTyping("/");
check("a slash lists every command", COMMANDS.every((c) => all.includes(`/${c.name}`)),
  COMMANDS.filter((c) => !all.includes(`/${c.name}`)).map((c) => c.name).join(", "));
check("the list explains what each one does", all.includes("what compaction hid"));

const filtered = await afterTyping("/c");
check("typing filters the list", filtered.includes("/context") && filtered.includes("/clear"));
check("non-matching commands are dropped", !filtered.includes("/help") && !filtered.includes("/sessions"),
  "help or sessions still listed");

// Only the palette's own rows. The composer's rules are the width of the
// terminal by design -- that is the accepted leak documented in the README,
// and not something this check is about.
const narrow = await afterTyping("/", 64);
const paletteRows = narrow.split("\n").filter((l) => /^\s+\/[a-z]/.test(l));
const widest = Math.max(0, ...paletteRows.map((l) => [...l].length));
check("the list adds no full-width lines of its own", paletteRows.length > 0 && widest < 64,
  `${paletteRows.length} rows, widest ${widest} of 64`);

const none = await afterTyping("hello");
check("ordinary text shows no list", !none.includes("list these commands"));

process.exit(failures ? 1 : 0);
