/**
 * The keyboard is never taken away.
 *
 * A turn can run for minutes; if typing is blocked for that long the next
 * instruction has to be held in the user's head until the agent finishes.
 * Typing stays live, Enter queues, and the queue flushes when the runtime
 * goes idle.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

let buf = "";
const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
  { columns: 92, rows: 30, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const bus = new EventBus();
const submitted: string[] = [];
const props = (busy: boolean) => ({
  bus, cwd: "/tmp", model: "m", version: "0.1.0", backend: "b", sandbox: "off",
  busy, onSubmit: (t: string) => submitted.push(t), onCancel: () => {}, onPermission: () => {},
});

const app = render(<App {...props(true)} />, { stdout: stdout as any, stdin: stdin as any, patchConsole: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = () => buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

await wait(120);
check("composer is live while busy", /type to queue/.test(plain()));

buf = "";
stdin.write("run the linter next");
await wait(120);
check("keystrokes reach the composer while busy", /run the linter next/.test(plain()));

buf = "";
stdin.write("\r");
await wait(150);
check("Enter does not submit while busy", submitted.length === 0, `submitted ${submitted.length}`);
check("queued line is shown", /queued/.test(plain()));

buf = "";
app.rerender(<App {...props(false)} />);
await wait(200);
check("queue flushes when idle", submitted.length === 1 && submitted[0] === "run the linter next",
  JSON.stringify(submitted));

app.unmount();
await app.waitUntilExit();
process.exit(failures ? 1 : 0);
