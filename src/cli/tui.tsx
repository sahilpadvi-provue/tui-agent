/**
 * The terminal client.
 *
 * This is the only layer that knows about every other one. The UI is handed
 * `bus` and four callbacks and holds no reference to the loop, the executor or
 * the model -- which is what `scripts/log-equivalence.tsx` checks.
 */
import React from "react";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pkg from "../../package.json" with { type: "json" };

import { EventBus } from "../core/bus.ts";
import { EventLog } from "../core/log.ts";
import { AgentLoop } from "../core/loop.ts";
import { LocalExecutor } from "../exec/local.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { builtinTools } from "../tools/builtin.ts";
import { PermissionPolicy } from "../permissions/policy.ts";
import { OllamaClient } from "../model/ollama.ts";
import { SYSTEM_PROMPT } from "../core/prompt.ts";
import { mount } from "../ui/primitives.tsx";
import { App, type SessionChoice } from "../ui/App.tsx";
import { runCommand, type CommandContext } from "../commands/registry.ts";
import { listSessions, resume, sessionLine } from "../core/session.ts";
import { dark, themeNamed, type Theme } from "../theme/index.ts";
import type { AgentEvent, PermissionDecision } from "../core/events.ts";

/** Empty when the workspace is not a repo, which is a normal way to run. */
function currentBranch(dir: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" });
  const name = r.stdout?.trim();
  return r.status === 0 && name && name !== "HEAD" ? name : undefined;
}

const cwd = process.cwd();
const branch = currentBranch(cwd);

/**
 * One bus for the process, whichever session is open.
 *
 * The UI subscribes to it once, at mount. Replacing the bus on a session
 * switch would leave that subscription pointed at the old one and the screen
 * would simply stop updating, so the bus stays and its sequence is moved to
 * where the resumed log ended.
 */
const bus = new EventBus();

// Mutable because `/resume` swaps all four at once. The handler below closes
// over the bindings rather than the values, so it follows them.
let sessionId = randomUUID().slice(0, 8);
let log = new EventLog(".sessions", sessionId);
let model = new OllamaClient(process.env.MODEL ?? "qwen3:8b");
// Selected the way MODEL is, and falling back rather than failing: a mistyped
// theme is not a reason to refuse to start.
let theme: Theme = themeNamed(process.env.THEME ?? "") ?? dark;
let history: AgentEvent[] = [];
/** A new array is what tells the UI to replace the transcript. */
let seed: readonly AgentEvent[] | undefined;
let sessionChoices: readonly SessionChoice[] = [];

/**
 * The log is written on the first event, not at launch.
 *
 * Writing it eagerly created a session file before `--resume` had even been
 * read, so every resumed launch left an empty session behind -- and
 * `--continue`, which takes the most recent, then picked that empty one and
 * showed a blank transcript. It is also why a workspace collects `0 events`
 * sessions: every launch that was only a look around left one.
 */
let metaWritten = false;
bus.on((e) => {
  if (!metaWritten) {
    log.writeMeta({ sessionId, startedAt: new Date().toISOString(), cwd, model: model.name });
    metaWritten = true;
  }
  log.append(e);
  history.push(e);
});

/** Matches `resume()`: the same directory by a different path is the same one. */
function sameWorkspace(dir: string): boolean {
  if (dir === cwd) return true;
  try {
    return realpathSync(dir) === realpathSync(cwd);
  } catch {
    return false;
  }
}

function refreshSessions(): void {
  // Filtered by workspace, because `resume()` refuses a session recorded
  // elsewhere -- offering one would be offering something that cannot be
  // chosen.
  sessionChoices = listSessions().filter((s) => sameWorkspace(s.meta.cwd)).map((s) => ({
    id: s.id,
    label: `${s.lastAt.slice(0, 16).replace("T", " ")}  ${String(s.events).padStart(5)} events  ${s.firstPrompt}`,
  }));
}

const exec = new LocalExecutor(cwd, { sandbox: true, allowNetwork: true });
const tools = new ToolRegistry();
for (const t of builtinTools) tools.register(t);

let resolvePermission: ((d: PermissionDecision) => void) | undefined;
let loop = buildLoop();

// ---- launch: a fresh session, or one of the earlier ones -------------------

refreshSessions();

const argv = process.argv.slice(2);
const wantsResume = argv.some((a) => a === "--resume" || a.startsWith("--resume="));
const wantsContinue = argv.includes("--continue") || argv.includes("-c");
const askedFor = flagValue("--resume");
let initialInput: string | undefined;

if (wantsContinue) {
  const latest = sessionChoices[0];
  if (!latest) die("nothing to continue: no sessions recorded in this workspace");
  open(latest.id);
} else if (askedFor) {
  open(askedFor);
} else if (wantsResume) {
  // An id was asked for and not given, so ask rather than guess. Holding the
  // command with an empty argument is what opens the picker, so the session
  // list is the first thing on screen.
  if (!sessionChoices.length) die("nothing to resume: no sessions recorded in this workspace");
  initialInput = "/resume ";
}

function open(id: string): void {
  try {
    openSession(id);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

function flagValue(flag: string): string | undefined {
  const i = argv.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i === -1) return undefined;
  const a = argv[i]!;
  if (a.includes("=")) return a.split("=")[1];
  const next = argv[i + 1];
  // A flag is not a value.
  return next === undefined || next.startsWith("-") ? undefined : next;
}

/** Before the UI is mounted there is no screen to report on, so use the one we have. */
function die(message: string): never {
  console.error(message);
  const found = listSessions().filter((s) => sameWorkspace(s.meta.cwd));
  if (found.length) {
    console.error("\nsessions in this workspace:\n");
    for (const s of found.slice(0, 15)) console.error(`  ${sessionLine(s)}`);
    console.error("\n  bun run tui --resume <id>      pick one");
    console.error("  bun run tui --continue         the most recent");
  }
  process.exit(1);
}

/**
 * The loop takes its model and its starting history at construction, so
 * changing either -- /model, /clear -- means building a new one. The bus, the
 * log and the transcript are untouched, so nothing on screen or on disk moves.
 */
function buildLoop(startFrom: AgentEvent[] = history) {
  return new AgentLoop({
    sessionId,
    bus,
    model,
    tools,
    policy: new PermissionPolicy(),
    toolContext: { exec, opts: { cwd } },
    systemPrompt: SYSTEM_PROMPT,
    checkpoints: true,
    history: startFrom,
    ask: () => new Promise<PermissionDecision>((r) => { resolvePermission = r; }),
  });
}

/**
 * Everything a command may reach. Each is implemented against something local
 * today; `availableModels` is the one that becomes a gateway call, and it is
 * injected here rather than imported so that swap is a change to this file.
 */
const commandContext: CommandContext = {
  // A getter, not a value: `/resume` changes which session this is, and a
  // captured copy would keep naming the one we left.
  get sessionId() { return sessionId; },
  cwd,
  get history() { return history; },
  get model() { return model.name; },
  availableModels: () => model.listModels(),
  setModel(name) {
    model = new OllamaClient(name);
    loop = buildLoop();
  },
  clear() {
    history = [];
    loop = buildLoop([]);
  },
  restore(seqs) {
    bus.emit({ sessionId, type: "context.restored", restoredSeqs: seqs });
  },
  resume(id) {
    openSession(id);
  },
  get theme() { return theme.id; },
  setTheme(next) {
    theme = next;
  },
};

/**
 * Switch this client to another session.
 *
 * Four things move together and none of them can move alone: the log being
 * appended to, the bus's sequence, the history the loop sends to the model,
 * and the transcript on screen. `resume()` throws for an unknown id or a
 * session recorded against another workspace, and the caller reports that.
 */
function openSession(id: string): void {
  const prior = resume(id, ".sessions", cwd);
  sessionId = prior.meta.sessionId;
  log = prior.log;
  history = [...prior.history];
  // The log is the only record of where the sequence got to, so the bus is
  // moved to just past its last event rather than restarted.
  bus.resumeFrom((prior.history.at(-1)?.seq ?? -1) + 1);
  // The resumed log already has its meta line, and appending a second one
  // would make the file unreadable.
  metaWritten = true;
  loop = buildLoop(history);
  seed = [...prior.history];
  refreshSessions();
}

let busy = false;

function view() {
  return (
    <App
      bus={bus}
      cwd={cwd}
      model={model.name}
      version={pkg.version}
      backend="ollama"
      sandbox={exec.describeSandbox()}
      branch={branch}
      busy={busy}
      theme={theme}
      sessions={sessionChoices}
      seed={seed}
      initialInput={initialInput}
      onSubmit={(text) => { void run(text); }}
      onCommand={(input) => { void invoke(input); }}
      onCancel={() => loop.cancel()}
      onPermission={(d) => { resolvePermission?.(d); resolvePermission = undefined; }}
    />
  );
}

const instance = mount(view());
const rerender = () => instance.rerender(view());

// Deliberately no resize handler here. Ink installs its own and re-renders
// synchronously; clearing alongside it raced -- Ink would write an identical
// frame, skip it as unchanged, and leave the screen blank where the composer
// had been. The repeating live region that prompted this is ink#907, closed
// upstream as not planned; what actually reduces it is not redrawing
// thousands of identical frames, which src/ui/model.ts now avoids.

async function run(text: string) {
  busy = true;
  rerender();
  try {
    await loop.run(text);
  } finally {
    busy = false;
    rerender();
  }
}

async function invoke(input: string) {
  const result = await runCommand(input, commandContext);
  bus.emit({
    sessionId,
    type: "local.invoked",
    command: result.name,
    args: result.rest,
    ok: result.ok,
    output: result.output,
  });
  rerender();
}

await instance.waitUntilExit();
// An in-flight model request or raw-mode stdin can hold the process open
// after the UI unmounts; the user asked to leave, so leave.
process.exit(0);
