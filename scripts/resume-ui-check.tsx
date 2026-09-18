/**
 * Resuming a session in the terminal client, end to end.
 *
 * `resume-check.ts` covers the log and the headless CLI. This covers the part
 * a person actually uses: launching into an earlier session, picking one from
 * a list, and switching without quitting. It was all unimplemented -- the TUI
 * had no resume flag at all and `/resume` only printed instructions -- so
 * every check here is a claim that had no coverage.
 *
 * The launch paths spawn the real client. The picker cannot be driven that
 * way: a spawned process has a non-TTY stdin, so `mount` attaches no key
 * handler, which is why the interaction is driven against a mounted `App`
 * with a fake TTY instead.
 */
import React from "react";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { EventBus } from "../src/core/bus.ts";
import { EventLog } from "../src/core/log.ts";
import { App, type SessionChoice } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { screen } from "./vt.ts";
import type { AgentEvent } from "../src/core/events.ts";
import { dark } from "../src/theme/index.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ws = mkdtempSync(join(tmpdir(), "resume-ui-"));
mkdirSync(join(ws, ".sessions"), { recursive: true });

function seedSession(id: string, question: string, answer: string) {
  const log = new EventLog(join(ws, ".sessions"), id);
  log.writeMeta({ sessionId: id, startedAt: new Date().toISOString(), cwd: ws, model: "scripted" });
  const bus = new EventBus();
  bus.on((e) => log.append(e));
  bus.emit({ sessionId: id, type: "message.started", id: "u0", role: "user" });
  bus.emit({ sessionId: id, type: "message.completed", id: "u0", text: question });
  bus.emit({ sessionId: id, type: "message.started", id: "a0", role: "assistant" });
  bus.emit({ sessionId: id, type: "message.completed", id: "a0", text: answer });
  bus.emit({ sessionId: id, type: "turn.completed", turn: 1, usage: { input: 10, output: 5 } });
}

seedSession("aaa11111", "what colour is the sky", "The sky is BLUEMARKER.");
// A second, newer session, so `--continue` has something to be wrong about.
await new Promise((r) => setTimeout(r, 1100));
seedSession("bbb22222", "what colour is grass", "Grass is GREENMARKER.");

const before = readdirSync(join(ws, ".sessions")).sort();

// ---- launching into a session ----------------------------------------------

const cli = new URL("../src/cli/tui.tsx", import.meta.url).pathname;
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** Spawns the real client, lets it draw, then stops it. */
async function launch(...args: string[]): Promise<{ out: string; code: number | null }> {
  const child = spawn(process.execPath, ["run", cli, ...args], {
    cwd: ws,
    env: { ...process.env, MODEL: "scripted", COLORTERM: "" },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 2600);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  return { out: plain(out), code };
}

const cont = await launch("--continue");
check("--continue opens the most recent session",
  cont.out.includes("GREENMARKER") && !cont.out.includes("BLUEMARKER"),
  cont.out.slice(-220));

const byId = await launch("--resume", "aaa11111");
check("--resume <id> opens that session",
  byId.out.includes("BLUEMARKER") && !byId.out.includes("GREENMARKER"),
  byId.out.slice(-220));
check("and its usage comes back with it", /10↑/.test(byId.out), byId.out.slice(-160));

const picker = await launch("--resume");
check("--resume with no id opens the picker",
  picker.out.includes("aaa11111") && picker.out.includes("bbb22222"),
  picker.out.slice(-260));
check("with the newest first", picker.out.indexOf("bbb22222") < picker.out.indexOf("aaa11111"));
check("and nothing is resumed until one is chosen",
  !picker.out.includes("BLUEMARKER") && !picker.out.includes("GREENMARKER"));

const bad = await launch("--resume", "nosuchid");
check("an unknown id is refused before the UI is mounted",
  bad.code === 1 && bad.out.includes("nosuchid"), `exit ${bad.code}: ${bad.out.slice(0, 200)}`);

/**
 * The log used to be created at launch, before `--resume` was read. Every
 * resumed launch therefore left an empty session behind, and `--continue`
 * picked that one.
 */
check("no launch left a stray session behind",
  JSON.stringify(readdirSync(join(ws, ".sessions")).sort()) === JSON.stringify(before),
  JSON.stringify(readdirSync(join(ws, ".sessions")).sort()));

// ---- the picker, and switching in place ------------------------------------

const sessions: SessionChoice[] = [
  { id: "bbb22222", label: "2026-09-18 05:37   5 events  what colour is grass" },
  { id: "aaa11111", label: "2026-09-18 05:37   5 events  what colour is the sky" },
];
const events = (id: string): AgentEvent[] =>
  EventLog.readFile(join(ws, ".sessions", `${id}.jsonl`)).events;

const vt = screen(96, 30);
const ran: string[] = [];
let seed: readonly AgentEvent[] | undefined;
const render = () => (
  <App theme={dark} bus={new EventBus()} cwd={ws} model="scripted" version="0" backend="b" sandbox="off"
       busy={false} sessions={sessions} seed={seed}
       onSubmit={() => {}} onCommand={(c) => ran.push(c)}
       onCancel={() => {}} onPermission={() => {}} />
);
const app = mount(render(), { stdout: vt.stdout, stdin: vt.stdin });
const settle = (ms = 140) => new Promise((r) => setTimeout(r, ms));
await settle();

vt.stdin.write("/resume ");
await settle();
const listed = vt.all().join("\n");
check("typing the command with an empty argument lists the sessions",
  listed.includes("aaa11111") && listed.includes("bbb22222"), listed.slice(-260));

// The command list must give way: what is being chosen is a session now.
check("and the command list is not also open", !/continue an earlier session/.test(listed),
  listed.slice(-200));

vt.stdin.write("\x1b[B");
await settle();
vt.stdin.write("\r");
await settle();
check("arrowing down and pressing Enter runs it for the second session",
  ran.join("|") === "/resume aaa11111", JSON.stringify(ran));

// What the wiring layer does once the command comes back: hand over a new
// transcript. A new array is the signal.
seed = events("aaa11111");
app.rerender(render());
await settle();
const swapped = vt.all().join("\n");
check("a new seed replaces what is on screen", swapped.includes("BLUEMARKER"), swapped.slice(-240));

seed = events("bbb22222");
app.rerender(render());
await settle(200);
const swappedBack = vt.all().join("\n");
check("and switching again replaces it rather than appending",
  swappedBack.includes("GREENMARKER"), swappedBack.slice(-240));

// Typing part of an id narrows the list, which is the only way to pick from a
// workspace with more sessions than the picker shows rows for.
vt.stdin.write("/resume aaa");
await settle();
const filtered = vt.all().join("\n");
check("the argument filters the list", filtered.includes("aaa11111"), filtered.slice(-200));

app.unmount();
await app.waitUntilExit();
rmSync(ws, { recursive: true, force: true });
console.log(failures === 0 ? "\nresume works from the terminal client" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
