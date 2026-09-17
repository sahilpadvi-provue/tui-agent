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
import { runCommand, isCommand, COMMANDS, type CommandContext } from "../src/commands/registry.ts";
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

// ---------------------------------------------------------------------------
// Moving through the list with the arrows, and what Enter does when it lands
// on a command that needs an argument.
// ---------------------------------------------------------------------------

async function drive(keys: string[], width = 100) {
  let out = "";
  const invoked: string[] = [];
  const prompted: string[] = [];
  const so = Object.assign(new Writable({ write(c, _e, cb) { out += String(c); cb(); return true; } }),
    { columns: width, rows: 30, isTTY: true });
  const si = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const b = new EventBus();
  const a = render(
    <App bus={b} cwd={ws} model="m" version="0" backend="b" sandbox="off" busy={false}
         onSubmit={(t) => prompted.push(t)} onCommand={(c) => invoked.push(c)} onCancel={() => {}} onPermission={() => {}} />,
    { stdout: so as any, stdin: si as any, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 110));
  for (const k of keys) { si.write(k); await new Promise((r) => setTimeout(r, 55)); }
  await new Promise((r) => setTimeout(r, 130));
  a.unmount();
  await a.waitUntilExit();
  const frames = out.split("\x1b[?2026h");
  const last = (frames[frames.length - 1] ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const highlighted = last.split("\n").filter((l) => l.trim().startsWith("\u203a") && l.includes("/"));
  const prompt = last.split("\n").find((l) => l.includes("\u203a ") && l.includes("\u258f")) ?? "";
  return { invoked, prompted, highlighted: highlighted.map((l) => l.trim().slice(2).split(" ")[0]), prompt: prompt.trim() };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";

const opened = await drive(["/"]);
check("the first command is highlighted on open", opened.highlighted.includes("/help"),
  JSON.stringify(opened.highlighted));

const moved = await drive(["/", DOWN, DOWN]);
check("down moves the highlight", moved.highlighted.includes("/restore"), JSON.stringify(moved.highlighted));

const back = await drive(["/", DOWN, DOWN, UP]);
check("up moves it back", back.highlighted.includes("/context"), JSON.stringify(back.highlighted));

const enterNoArgs = await drive(["/", DOWN, "\r"]);
check("enter runs a command that needs nothing", enterNoArgs.invoked.join() === "/context",
  JSON.stringify(enterNoArgs.invoked));

const enterNeedsArgs = await drive(["/", "r", "\r"]);
check("enter completes a command that needs an argument rather than running it",
  enterNeedsArgs.invoked.length === 0 && enterNeedsArgs.prompt.includes("/restore"),
  `${JSON.stringify(enterNeedsArgs.invoked)} ${JSON.stringify(enterNeedsArgs.prompt)}`);

const withArgs = await drive(["/", "r", "\r", "4", ",", "5", "\r"]);
check("then it runs with what was typed", withArgs.invoked.join() === "/restore 4,5",
  JSON.stringify(withArgs.invoked));

const tabbed = await drive(["/", "c", "\t"]);
check("tab completes without running", tabbed.invoked.length === 0 && tabbed.prompt.includes("/context"),
  JSON.stringify(tabbed.prompt));

// ---------------------------------------------------------------------------
// A leading slash is not enough to make something a command.
//
// An absolute path starts with one too, and asking about a file is an ordinary
// thing to do. This was answered with `unknown command` and never reached the
// model, which is the worst shape of failure: confident and wrong.
// ---------------------------------------------------------------------------

for (const [text, kind] of [
  ["/help", "command"],
  ["/restore 4,5", "command"],
  ["/halp", "command"],
  ["/Users/me/project/src/App.tsx", "prompt"],
  ["/src/ui/layout.ts what does STEP do", "prompt"],
  ["/notes.md", "prompt"],
  ["look at /Users/me/x.ts", "prompt"],
] as const) {
  check(`${JSON.stringify(text)} is a ${kind}`, isCommand(text) === (kind === "command"));
}

// And through the composer, which is where it actually bit.
const pathTyped = await drive(["/Users/me/project/src/App.tsx", "\r"]);
check("a typed path is sent to the model, not run as a command",
  pathTyped.prompted.join() === "/Users/me/project/src/App.tsx" && pathTyped.invoked.length === 0,
  `prompted ${JSON.stringify(pathTyped.prompted)} invoked ${JSON.stringify(pathTyped.invoked)}`);

const stillRuns = await drive(["/help", "\r"]);
check("a real command still runs", stillRuns.invoked.join() === "/help" && stillRuns.prompted.length === 0,
  `invoked ${JSON.stringify(stillRuns.invoked)}`);


process.exit(failures ? 1 : 0);
