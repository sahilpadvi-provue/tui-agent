/**
 * Stage 2: the terminal client.
 *
 * It wires the same runtime the headless driver uses and mounts a view over
 * the bus. Note what is absent: the UI is handed `bus`, `onSubmit`, `onCancel`
 * and `onPermission`, and has no reference to the loop, the executor or the
 * model.
 */
import React from "react";
import { randomUUID } from "node:crypto";
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
import type { PermissionDecision } from "../core/events.ts";

const cwd = process.cwd();
const sessionId = randomUUID().slice(0, 8);
const bus = new EventBus();
const log = new EventLog(".sessions", sessionId);
const model = new OllamaClient(process.env.MODEL ?? "qwen3:8b");

log.writeMeta({ sessionId, startedAt: new Date().toISOString(), cwd, model: model.name });
bus.on((e) => log.append(e));

const exec = new LocalExecutor(cwd);
const tools = new ToolRegistry();
for (const t of builtinTools) tools.register(t);

let resolvePermission: ((d: PermissionDecision) => void) | undefined;

const loop = new AgentLoop({
  sessionId,
  bus,
  model,
  tools,
  policy: new PermissionPolicy(),
  toolContext: { exec, opts: { cwd } },
  systemPrompt: SYSTEM_PROMPT,
  ask: () => new Promise<PermissionDecision>((r) => { resolvePermission = r; }),
});

let busy = false;
const instance = mount(
  <App
    bus={bus}
    cwd={cwd}
    model={model.name}
    busy={busy}
    onSubmit={(text) => { void run(text); }}
    onCancel={() => loop.cancel()}
    onPermission={(d) => { resolvePermission?.(d); resolvePermission = undefined; }}
  />,
);

function rerender() {
  instance.rerender(
    <App
      bus={bus}
      cwd={cwd}
      model={model.name}
      busy={busy}
      onSubmit={(text) => { void run(text); }}
      onCancel={() => loop.cancel()}
      onPermission={(d) => { resolvePermission?.(d); resolvePermission = undefined; }}
    />,
  );
}

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

await instance.waitUntilExit();
