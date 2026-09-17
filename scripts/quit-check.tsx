/** Ctrl-C when idle must quit: once to arm, twice to exit. */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

let buf = "";
const stdout = Object.assign(new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
  { columns: 90, rows: 24, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const app = render(
  <App bus={new EventBus()} cwd="/tmp" model="m" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={false}
       onSubmit={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let exited = false;
app.waitUntilExit().then(() => { exited = true; });

await wait(120);
stdin.write("\x03");                       // first ctrl-c
await wait(120);
// Matches the intent, not the exact copy, so rewording the hint is not a failure.
const armed = /ctrl-c again/i.test(buf.replace(/\x1b\[[0-9;]*m/g, ""));
console.log(`first ctrl-c arms the prompt: ${armed}`);
console.log(`still running after one press: ${!exited}`);

stdin.write("\x03");                       // second ctrl-c
await wait(200);
console.log(`exited after second press: ${exited}`);
process.exit(armed && exited ? 0 : 1);
