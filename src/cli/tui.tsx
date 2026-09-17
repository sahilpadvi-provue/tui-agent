/**
 * The terminal client.
 *
 * This is the only layer that knows about every other one. The UI is handed
 * `bus` and four callbacks and holds no reference to the loop, the executor or
 * the model -- which is what `scripts/log-equivalence.tsx` checks.
 */
import React from "react";
import { randomUUID } from "node:crypto";
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
import { App } from "../ui/App.tsx";
import { runCommand, type CommandContext } from "../commands/registry.ts";
import type { AgentEvent, PermissionDecision } from "../core/events.ts";

/** Empty when the workspace is not a repo, which is a normal way to run. */
function currentBranch(dir: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" });
  const name = r.stdout?.trim();
  return r.status === 0 && name && name !== "HEAD" ? name : undefined;
}

const cwd = process.cwd();
const sessionId = randomUUID().slice(0, 8);
const bus = new EventBus();
const log = new EventLog(".sessions", sessionId);
const branch = currentBranch(cwd);

let model = new OllamaClient(process.env.MODEL ?? "qwen3:8b");
let history: AgentEvent[] = [];

log.writeMeta({ sessionId, startedAt: new Date().toISOString(), cwd, model: model.name });
bus.on((e) => {
  log.append(e);
  history.push(e);
});

const exec = new LocalExecutor(cwd, { sandbox: true, allowNetwork: true });
const tools = new ToolRegistry();
for (const t of builtinTools) tools.register(t);

let resolvePermission: ((d: PermissionDecision) => void) | undefined;
let loop = buildLoop();

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
  sessionId,
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
};

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
      onSubmit={(text) => { void run(text); }}
      onCommand={(input) => { void invoke(input); }}
      onCancel={() => loop.cancel()}
      onPermission={(d) => { resolvePermission?.(d); resolvePermission = undefined; }}
    />
  );
}

const instance = mount(view());
const rerender = () => instance.rerender(view());

/**
 * Ink erases its previous frame by counting the lines it wrote. A resize
 * changes how many rows those lines occupy, so the count stops matching the
 * screen, the erase falls short, and every frame after it appends instead of
 * replacing -- the live region repeating down the terminal (ink#907, closed
 * upstream as not planned).
 *
 * Clearing discards that bookkeeping and starts the next frame from a known
 * state. It costs the current frame, which is redrawn immediately.
 */
process.stdout.on("resize", () => {
  instance.clear();
  rerender();
});

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
