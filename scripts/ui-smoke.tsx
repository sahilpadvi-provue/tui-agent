/** Renders the App against a fake bus and prints the final frame. */
import React from "react";
import { render } from "ink";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

const bus = new EventBus();
const sid = "smoke";
const out: string[] = [];
const fakeStdout = Object.assign(new (require("node:stream").Writable)({
  write(c: any, _e: any, cb: any) { out.push(String(c)); cb?.(); return true; },
}), { columns: 80, rows: 20, isTTY: false });

const { PassThrough } = require("node:stream");
const fakeStdin = Object.assign(new PassThrough(), {
  isTTY: true,
  setRawMode() {},
  ref() {}, unref() {},
});

const app = render(
  <App bus={bus} cwd="/tmp/demo-repo" model="qwen3:8b" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={false}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout: fakeStdout as any, stdin: fakeStdin as any, interactive: false, patchConsole: false },
);

const emit = (e: any) => bus.emit({ sessionId: sid, ...e });
emit({ type: "message.started", id: "u1", role: "user" });
emit({ type: "message.completed", id: "u1", text: "fix the failing test" });
emit({ type: "reasoning.started", id: "r1" });
emit({ type: "reasoning.delta", id: "r1", text: "x".repeat(120) });
emit({ type: "reasoning.completed", id: "r1", payload: { raw: {} } });
emit({ type: "tool.started", callId: "c1", name: "shell" });
emit({ type: "tool.ended", callId: "c1", args: { command: "node test.js" } });
emit({ type: "command.output", callId: "c1", stream: "stdout", chunk: "FAIL empty input\n" });
emit({ type: "tool.result", callId: "c1", ok: true, result: "FAIL empty input\n[exit 1]" });
emit({ type: "turn.completed", turn: 1, usage: { input: 584, output: 286 } });
emit({ type: "message.started", id: "a1", role: "assistant" });
emit({ type: "message.delta", id: "a1", text: "The parser does not guard empty input." });
emit({ type: "message.completed", id: "a1", text: "The parser does not guard empty input." });
emit({ type: "permission.requested", requestId: "p1", callId: "c2", tool: "shell",
       blastRadius: { writes: ["/tmp/demo-repo"], network: true, command: "node test.js" } });

await new Promise((r) => setTimeout(r, 200));
app.unmount();
await app.waitUntilExit();
console.log("=== FINAL FRAME ===");
console.log(out.join("").replace(/\x1b\[[0-9;]*m/g, ""));
