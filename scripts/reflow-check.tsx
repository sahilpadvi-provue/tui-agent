/**
 * No line in the live region may reach the terminal's width.
 *
 * Ink erases its previous live frame with eraseLines(lines.length) -- a count
 * of logical lines. When the terminal narrows, it re-wraps that frame to the
 * new width first, so the frame occupies more physical rows than it has
 * lines. Ink erases the smaller number and the surplus rows survive, with the
 * next frame drawn beneath them. Every narrowing leaks one row per line that
 * was wider than the new width.
 *
 * This is ink#907, closed upstream as not planned, and it cannot be patched
 * from outside: repainting still has to erase by line count first. What can be
 * controlled is the input to that count, which makes it a layout rule rather
 * than a rendering bug: keep the live frame's lines short and there is nothing
 * to miscount. Full-width rules, space-between footers and progress bars are
 * what cost rows; ordinary text costs none.
 *
 * The settled transcript is exempt -- Static prints it once and never erases
 * it, so its width is the terminal's problem, exactly as ordinary scrollback is.
 *
 * THIS IS EXPECTED TO FAIL, deliberately.
 *
 * Satisfying it meant giving up the composer's border and the footer's right
 * edge, and the result did not look like the product we want. The borders were
 * put back and the leak accepted for now, so this is a measurement rather than
 * a gate: it says exactly what the current design costs (two full-width lines,
 * so two ghost rows per narrowing step) and it will pass the day the renderer
 * can carry full-width chrome safely.
 *
 * Do not add it to the gate suite, and do not fix it by trimming the UI again
 * without asking -- that trade has been made and rejected once.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

async function liveFrame(width: number, busy: boolean, drive: (e: (x: any) => void) => void) {
  let buf = "";
  const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
    { columns: width, rows: 40, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const bus = new EventBus();
  const app = render(
    <App bus={bus} cwd="/tmp/demo" model="qwen3:8b" version="0.1.0" backend="ollama"
         sandbox="seatbelt, network on" branch="main" busy={busy}
         onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
    { stdout: stdout as any, stdin: stdin as any, patchConsole: false },
  );
  drive((x) => bus.emit({ sessionId: "s", ...x }));
  await new Promise((r) => setTimeout(r, 220));
  app.unmount();
  await app.waitUntilExit();

  // The last frame Ink wrote, which is the one it will have to erase.
  const frames = buf.split("\x1b[?2026h");
  return (frames[frames.length - 1] ?? "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .split("\n")
    .map((l) => [...l].length)
    .filter((n) => n > 0);
}

const states: [string, boolean, (e: (x: any) => void) => void][] = [
  ["idle, empty", false, () => {}],
  ["working", true, (e) => {
    e({ type: "message.started", id: "u", role: "user" });
    e({ type: "message.completed", id: "u", text: "fix the failing parser test" });
    e({ type: "reasoning.started", id: "r" });
  }],
  ["awaiting approval", true, (e) => {
    e({ type: "tool.started", callId: "c", name: "shell" });
    e({ type: "tool.ended", callId: "c", args: { command: "rm -r dist && npm run build" } });
    e({ type: "permission.requested", requestId: "p", callId: "c", tool: "shell",
        blastRadius: { writes: ["/tmp/demo"], network: true, command: "rm -r dist && npm run build" } });
  }],
  // One exchange only: a second would add a settled exchange rule, which is
  // printed by Static and never erased, so its width is not this gate's
  // business and would only obscure the lines that are.
  ["after a turn", false, (e) => {
    e({ type: "message.started", id: "u", role: "user" });
    e({ type: "message.completed", id: "u", text: "fix the failing parser test in src/parse.js" });
    e({ type: "tool.started", callId: "c", name: "shell" });
    e({ type: "tool.ended", callId: "c", args: { command: "npm test -- --reporter=spec" } });
    e({ type: "tool.result", callId: "c", ok: true, result: "3 passing\n[exit 0]" });
  }],
];

for (const width of [60, 100, 160]) {
  for (const [name, busy, drive] of states) {
    const widths = await liveFrame(width, busy, drive);
    const offenders = widths.filter((n) => n >= width);
    check(`${name} @ ${width} has no full-width line`, offenders.length === 0,
      `${offenders.length} line(s) at ${offenders.join(", ")} of ${width}`);
  }
}

process.exit(failures ? 1 : 0);
