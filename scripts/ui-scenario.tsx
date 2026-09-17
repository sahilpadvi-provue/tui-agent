/**
 * Renders a realistic session and prints the frame with a column ruler.
 * Used to judge spacing and density against real content rather than
 * short placeholders.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

const COLS = Number(process.env.COLS ?? 100);
let buf = "";
const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
  { columns: COLS, rows: 60, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const bus = new EventBus();
const app = render(
  <App bus={bus} cwd="/Users/sahilpadvi/Desktop/TUI" model="qwen3:8b" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={false}
       onSubmit={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout: stdout as any, stdin: stdin as any, patchConsole: false },
);

const e = (x: any) => bus.emit({ sessionId: "s", ...x });
let n = 0;
const id = () => `x${n++}`;

function user(text: string) { const i = id(); e({ type: "message.started", id: i, role: "user" }); e({ type: "message.completed", id: i, text }); }
function assistant(text: string) { const i = id(); e({ type: "message.started", id: i, role: "assistant" }); e({ type: "message.completed", id: i, text }); }
function thought(chars: number) { const i = id(); e({ type: "reasoning.started", id: i }); e({ type: "reasoning.delta", id: i, text: "x".repeat(chars) }); e({ type: "reasoning.completed", id: i, payload: { raw: {} } }); }
function tool(name: string, args: unknown, result: string, ok = true) {
  const c = id();
  e({ type: "tool.started", callId: c, name });
  e({ type: "tool.ended", callId: c, args });
  e({ type: "tool.result", callId: c, ok, result });
}

// A full exchange, of the shape a real session takes.
user("the parser drops trailing whitespace on quoted fields — find it and fix it, then run the tests");
thought(1840);
tool("shell", { command: "npm test" }, `> csv-parser@1.4.0 test\n> node --test\n\n✔ parses simple rows (2.1ms)\n✔ handles embedded commas (0.9ms)\n✖ preserves whitespace inside quotes (3.4ms)\n  AssertionError: expected [ 'a', ' b ' ] to deeply equal [ 'a', ' b ' ]\n      at Object.<anonymous> (test/parse.test.js:41:5)\n\n2 passing, 1 failing\n[exit 1]`, true);
tool("search", { pattern: "trim\\(\\)" }, "src/parse.js:18:      .map((f) => f.trim())\nsrc/parse.js:44:  return raw.trim();\nsrc/format.js:9:  return value.trim();", true);
tool("read_file", { path: "src/parse.js" }, " 14| export function parseRow(line) {\n 15|   const fields = splitRespectingQuotes(line);\n 16|   return fields\n 17|     .map((f) => unquote(f))\n 18|     .map((f) => f.trim());\n 19| }", true);
assistant("The trim runs after unquoting, so it strips whitespace that was inside the quotes and therefore significant. It should only apply to unquoted fields.");
tool("replace_lines", { path: "src/parse.js", start_line: 16, end_line: 18, content: "  return fields.map((f) => (isQuoted(f) ? unquote(f) : f.trim()));" }, "replaced lines 16-18 of src/parse.js (3 -> 1 lines)", true);
e({ type: "file.changed", path: "src/parse.js", change: "modified" });
tool("shell", { command: "npm test" }, "✔ parses simple rows (2.0ms)\n✔ handles embedded commas (1.1ms)\n✔ preserves whitespace inside quotes (0.8ms)\n\n3 passing\n[exit 0]", true);
assistant("Fixed. `parseRow` was calling `.trim()` on every field after unquoting, which removed whitespace that the quotes were there to protect.\n\nThe change applies `trim()` only to unquoted fields. All three tests pass.");

user("now do the same for the header row");
thought(620);
tool("read_file", { path: "src/header.js" }, "1| export function parseHeader(line) {\n2|   return line.split(\",\").map((h) => h.trim());\n3| }", true);
tool("replace_lines", { path: "src/header.js", start_line: 2, end_line: 2, content: "  return splitRespectingQuotes(line).map((h) => (isQuoted(h) ? unquote(h) : h.trim()));" }, "replaced lines 2-2 of src/header.js (1 -> 1 lines)", true);
tool("shell", { command: "npm test" }, "✖ header keeps quoted spacing\n  ReferenceError: splitRespectingQuotes is not defined\n[exit 1]", false);
e({ type: "error", message: "tool reported a failure the model must handle", fatal: false });
tool("replace_lines", { path: "src/header.js", start_line: 1, end_line: 1, content: "import { splitRespectingQuotes, isQuoted, unquote } from \"./parse.js\";\n\nexport function parseHeader(line) {" }, "replaced lines 1-1 of src/header.js (1 -> 3 lines)", true);
e({ type: "context.compacted", droppedSeqs: [12, 13, 14], summary: "read src/parse.js, src/header.js; ran `npm test`", reason: "context 31204 tokens over 28672 budget (window 40960)" });
tool("shell", { command: "npm test" }, "4 passing\n[exit 0]", true);
// Deliberately ragged: models end messages with whatever whitespace they end
// with, and the rhythm on screen must not depend on it.
assistant("Done. The header row now uses the same quote-aware split, with the import added.\n\n\n");
e({ type: "turn.completed", turn: 9, usage: { input: 18432, output: 2106 } });

await new Promise((r) => setTimeout(r, 250));
app.unmount();
await app.waitUntilExit();

// RAW=1 keeps the escape sequences, so styling can be inspected rather than
// assumed -- a terminal's whole type hierarchy lives in them.
const frame = process.env.RAW ? buf : buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const lines = frame.split("\n");
if (!process.env.RAW) {
  const ruler = "0123456789".repeat(Math.ceil(COLS / 10)).slice(0, COLS);
  console.log("    " + ruler);
}
lines.forEach((l, i) =>
  console.log(process.env.RAW ? l : String(i + 1).padStart(3) + " " + l.replace(/\s+$/, "")),
);
console.log(`\n${lines.length} lines at ${COLS} columns`);
