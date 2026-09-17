/**
 * Resizing must not reprint the transcript.
 *
 * Static prints what it has not printed before and tracks that by count, so
 * the list it is given must be append-only in the strictest sense. Deriving
 * those lines from the current terminal width broke that: on resize every
 * line was re-wrapped, the count changed, and Ink printed the difference as
 * new content -- the transcript repeating itself down the screen.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App, countSettled } from "../src/ui/App.tsx";

let buf = "";
const stdout: any = Object.assign(
  new Writable({ write(c, _e, cb) { buf += String(c); cb(); return true; } }),
  { columns: 100, rows: 30, isTTY: true },
);
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const bus = new EventBus();
const app = render(
  <App bus={bus} cwd="/tmp/demo" model="m" version="0" backend="b" sandbox="off" busy={false}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
  { stdout, stdin: stdin as any, patchConsole: false },
);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = () => buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const count = (text: string, needle: string) => text.split(needle).length - 1;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const e = (x: any) => bus.emit({ sessionId: "s", ...x });

// A few settled turns, each with a recognisable marker.
for (let i = 0; i < 3; i++) {
  e({ type: "message.started", id: `u${i}`, role: "user" });
  e({ type: "message.completed", id: `u${i}`, text: `MARKER-${i} do the thing with a reasonably long instruction that will wrap at some widths` });
  e({ type: "tool.started", callId: `c${i}`, name: "shell" });
  e({ type: "tool.ended", callId: `c${i}`, args: { command: `npm test -- --grep marker-${i}` } });
  e({ type: "tool.result", callId: `c${i}`, ok: true, result: `RESULT-${i} 3 passing` });
}
await wait(200);

// The transcript form, with its prompt glyph. A bare marker also appears in
// the footer's session title, which is derived from the first request and is
// redrawn on every frame by design.
const asked = (i: number) => `\u203a MARKER-${i}`;

for (let i = 0; i < 3; i++) {
  check(`MARKER-${i} is in the transcript`, plain().includes(asked(i)));
}

// Now resize, twice, in both directions.
buf = "";
stdout.columns = 60;
stdout.emit("resize");
await wait(250);
const afterNarrow = plain();

stdout.columns = 140;
stdout.emit("resize");
await wait(250);
const afterWide = plain();

app.unmount();
await app.waitUntilExit();

for (let i = 0; i < 3; i++) {
  check(`request ${i} not reprinted on resize`, !afterWide.includes(asked(i)),
    `appeared ${count(afterWide, asked(i))} time(s)`);
  check(`output ${i} not reprinted on resize`, !afterWide.includes(`RESULT-${i}`));
}
check("narrowing alone did not reprint", !afterNarrow.includes(asked(0)),
  `${count(afterNarrow, asked(0))} occurrence(s)`);
check("the composer still redraws after a resize", afterWide.includes("describe a change"));

// ---------------------------------------------------------------------------
// The live region must stay bounded. It is redrawn whole every frame, so if it
// can grow with the session, it eventually exceeds the terminal height and Ink
// can no longer erase what it drew -- which is what put a repeating line down
// the whole screen.
// ---------------------------------------------------------------------------

import { reduce, initialState } from "../src/ui/model.ts";
import type { AgentEvent } from "../src/core/events.ts";

let state = initialState;
const apply = (e: Partial<AgentEvent> & { type: string }) =>
  (state = reduce(state, { seq: 0, at: "", sessionId: "s", ...e } as AgentEvent));

// A reasoning block that never completes, followed by plenty of work.
apply({ type: "reasoning.started", id: "r0" });
apply({ type: "reasoning.delta", id: "r0", text: "x".repeat(40) });
for (let i = 0; i < 40; i++) {
  apply({ type: "tool.started", callId: `t${i}`, name: "shell" });
  apply({ type: "tool.ended", callId: `t${i}`, args: { command: `step ${i}` } });
  apply({ type: "tool.result", callId: `t${i}`, ok: true, result: "done" });
}

const settledNow = countSettled(state.items);
check("an unfinished item does not pin the ones after it",
  state.items.length - settledNow <= 1,
  `${state.items.length - settledNow} of ${state.items.length} items live`);

process.exit(failures ? 1 : 0);

