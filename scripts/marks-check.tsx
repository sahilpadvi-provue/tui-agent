/**
 * The mark column answers "what did it change in my files".
 *
 * A tick used to mean "the call returned", so a read and a write were
 * distinguishable only by four characters of English — in colour and in
 * monochrome alike. This asserts the column carries it instead, which is where
 * hierarchy is supposed to live.
 *
 * Read through a terminal, because the escape sequences are the row
 * boundaries. Stripping them concatenates the screen into one line.
 */

import React from "react";
import { mount } from "../src/ui/primitives.tsx";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { screen } from "./vt.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

type Change = readonly [string, "created" | "modified"];

async function marks(
  calls: readonly { name: string; args: unknown; ok?: boolean; changes?: readonly Change[] }[],
): Promise<string[]> {
  const view = screen(92, 30);
  const bus = new EventBus();
  const app = mount(
    <App bus={bus} cwd="/p" model="m" version="0" backend="b" sandbox="off" branch="main"
         busy={false} onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}}
         onPermission={() => {}} />,
    { stdout: view.stdout, stdin: view.stdin },
  );
  const e = (x: Record<string, unknown>) => bus.emit({ sessionId: "s", ...x } as never);
  e({ type: "message.started", id: "u", role: "user" });
  e({ type: "message.completed", id: "u", text: "do the thing" });
  calls.forEach((c, n) => {
    const id = `c${n}`;
    e({ type: "tool.started", callId: id, name: c.name });
    e({ type: "tool.ended", callId: id, args: c.args });
    for (const [path, change] of c.changes ?? []) e({ type: "file.changed", path, change });
    e({ type: "tool.result", callId: id, ok: c.ok ?? true, result: "done" });
  });
  await new Promise((r) => setTimeout(r, 160));
  const rows = view.lines();
  app.unmount();

  // A tool row is the mark at column 4 followed by a space. Matching on the
  // mark set rather than on "any depth-1 row" keeps the banner's own indented
  // rows out; a mark that left the set makes its row vanish, which the caller
  // catches by counting.
  return rows
    .filter((l) => /^ {4}[\u2713\u2717+~\u00b7] /.test(l))
    .map((l) => l.trim()[0] ?? "");
}

const got = await marks([
  { name: "read_file", args: { path: "src/a.ts" } },
  { name: "write_file", args: { path: "src/b.ts" }, changes: [["src/b.ts", "created"]] },
  { name: "replace_lines", args: { path: "src/a.ts" }, changes: [["src/a.ts", "modified"]] },
  { name: "shell", args: { command: "npm test" } },
  { name: "shell", args: { command: "npm i" }, changes: [["package-lock.json", "modified"]] },
  { name: "edit_file", args: { path: "src/c.ts" }, ok: false },
]);

check("every call drew a row", got.length === 6, `${got.length} of 6: ${got.join(" ")}`);
check("a read is a tick, because nothing changed", got[0] === "✓", got[0]);
check("a create is +", got[1] === "+", got[1]);
check("a modify is ~", got[2] === "~", got[2]);
check("a command that changed nothing is a tick", got[3] === "✓", got[3]);
check("a command that changed something is not a tick", got[4] === "~", got[4]);
check("a failure is still a cross, whatever it touched", got[5] === "✗", got[5]);

check("a read and a write do not share a mark", got[0] !== got[1] && got[0] !== got[2]);
check("create and modify do not share a mark", got[1] !== got[2]);
check("the marks are ASCII where they carry the new meaning",
  /^[+~]$/.test(got[1] ?? "") && /^[+~]$/.test(got[2] ?? ""),
  "diff vocabulary needs no legend, and is unambiguous in width");

const mixed = await marks([
  { name: "shell", args: { command: "npm i" },
    changes: [["a.lock", "modified"], ["b.json", "created"]] },
]);
check("a call that created and modified reports the stronger of the two",
  mixed[0] === "+", mixed[0]);

process.exit(failures === 0 ? 0 : 1);
