/** Renders each interaction state so spacing can be judged in all of them. */
import React from "react";
import { mount } from "../src/ui/primitives.tsx";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

const COLS = 92;

async function frame(name: string, busy: boolean, drive: (e: (x: any) => void) => void) {
  let buf = "";
  const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
    { columns: COLS, rows: 40, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const bus = new EventBus();
  const app = mount(
    <App bus={bus} cwd="/Users/sahilpadvi/Desktop/TUI" model="qwen3:8b" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={busy}
         onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
    { stdout: stdout as any, stdin: stdin as any },
  );
  drive((x) => bus.emit({ sessionId: "s", ...x }));
  await new Promise((r) => setTimeout(r, 150));
  app.unmount();
  await app.waitUntilExit();

  const lines = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\n");
  // Only the final frame.
  const last = lines.slice(-Math.min(lines.length, 18));
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
  for (const l of last) console.log("  |" + l.replace(/\s+$/, ""));
}

await frame("empty — first launch", false, () => {});

await frame("streaming a reply", true, (e) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "explain the parser bug" });
  e({ type: "message.started", id: "a", role: "assistant" });
  e({ type: "message.delta", id: "a", text: "The trim runs after unquoting, so it strips whitespace that was inside the quotes and is therefore sig" });
});

await frame("tool running with live output", true, (e) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "run the tests" });
  e({ type: "tool.started", callId: "c", name: "shell" });
  e({ type: "tool.ended", callId: "c", args: { command: "npm test -- --reporter=spec" } });
  for (const l of ["> csv-parser@1.4.0 test", "> node --test", "✔ parses simple rows", "✔ handles embedded commas", "✔ trims unquoted fields", "✔ keeps quoted whitespace", "✔ handles CRLF"])
    e({ type: "command.output", callId: "c", stream: "stdout", chunk: l + "\n" });
});

await frame("awaiting approval", true, (e) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "clean the build directory" });
  e({ type: "tool.started", callId: "c", name: "shell" });
  e({ type: "tool.ended", callId: "c", args: { command: "rm -r dist && npm run build" } });
  e({ type: "permission.requested", requestId: "p", callId: "c", tool: "shell",
      blastRadius: { writes: ["/Users/sahilpadvi/Desktop/TUI"], network: true, command: "rm -r dist && npm run build" } });
});

await frame("working, with the composer still live", true, (e) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "fix the failing test" });
  e({ type: "tool.started", callId: "c", name: "shell" });
  e({ type: "tool.ended", callId: "c", args: { command: "npm test" } });
  e({ type: "command.output", callId: "c", stream: "stdout", chunk: "running 3 suites\n" });
});

await frame("failure", false, (e) => {
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "fix the import" });
  e({ type: "tool.started", callId: "c", name: "replace_lines" });
  e({ type: "tool.ended", callId: "c", args: { path: "src/header.js", start_line: 2, end_line: 2 } });
  e({ type: "tool.result", callId: "c", ok: false, result: 'ERROR: read src/header.js before editing it — call read_file first, then copy the exact text you want to replace' });
  e({ type: "error", message: "3 consecutive tool failures; stopping", fatal: true });
});
