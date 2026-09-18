/**
 * The standing proof of the first invariant: mounting the UI changes nothing
 * the runtime records.
 *
 * Running the same task twice cannot show this -- a model is not
 * deterministic, so the two logs would differ for reasons that say nothing
 * about the boundary. Instead one scripted model drives the same loop twice,
 * once with no client attached and once with the terminal UI mounted on the
 * bus, and the two event logs are compared. Any difference means the UI
 * reached into the runtime.
 */
import React from "react";
import { mount } from "../src/ui/primitives.tsx";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/core/bus.ts";
import { AgentLoop } from "../src/core/loop.ts";
import { LocalExecutor } from "../src/exec/local.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";
import { App } from "../src/ui/App.tsx";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelChunk, ModelClient } from "../src/model/client.ts";
import { dark } from "../src/theme/index.ts";

/** A model with no opinions: the same turns every time. */
class ScriptedModel implements ModelClient {
  readonly name = "scripted";
  readonly facts = { contextWindow: 16_384, cacheThreshold: null, supportsTools: true };
  #turn = 0;

  async *stream(): AsyncIterable<ModelChunk> {
    const turn = this.#turn++;
    if (turn === 0) {
      yield { kind: "reasoning", text: "I should look at the file first." };
      yield { kind: "tool_call", call: { id: "c1", name: "read_file", args: { path: "note.txt" } } };
      yield { kind: "done", usage: { input: 100, output: 20 }, reasoning: { raw: { t: 1 } } };
    } else if (turn === 1) {
      yield { kind: "tool_call", call: { id: "c2", name: "write_file", args: { path: "note.txt", content: "changed\n" } } };
      yield { kind: "done", usage: { input: 120, output: 15 } };
    } else if (turn === 2) {
      yield { kind: "tool_call", call: { id: "c3", name: "shell", args: { command: "cat note.txt" } } };
      yield { kind: "done", usage: { input: 130, output: 12 } };
    } else {
      yield { kind: "text", text: "Done: note.txt now reads \"changed\"." };
      yield { kind: "done", usage: { input: 140, output: 10 } };
    }
  }
}

async function runOnce(withUi: boolean): Promise<AgentEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), "logeq-"));
  writeFileSync(join(dir, "note.txt"), "original\n");

  const events: AgentEvent[] = [];
  const bus = new EventBus();
  bus.on((e) => events.push(e));

  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);

  const loop = new AgentLoop({
    sessionId: "fixed",
    bus,
    model: new ScriptedModel(),
    tools,
    policy: new PermissionPolicy(),
    toolContext: { exec: new LocalExecutor(dir, { sandbox: false }), opts: { cwd: dir } },
    systemPrompt: "scripted",
    ask: async () => ({ kind: "allow", scope: "once" }),
  });

  let app: ReturnType<typeof mount> | undefined;
  if (withUi) {
    const stdout = Object.assign(new Writable({ write(_c, _e, cb) { cb(); return true; } }),
      { columns: 92, rows: 30, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    app = mount(
      <App theme={dark} bus={bus} cwd={dir} model="scripted" version="0.1.0" backend="scripted"
           sandbox="off" busy onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />,
      { stdout: stdout as any, stdin: stdin as any },
    );
  }

  await loop.run("change the note and show me");
  if (app) { app.unmount(); await app.waitUntilExit(); }
  rmSync(dir, { recursive: true, force: true });
  return events;
}

/** Strips what legitimately differs between two runs: clocks, ids, temp paths. */
function normalise(events: AgentEvent[]): string {
  return events
    .map((e) => {
      const copy: Record<string, unknown> = { ...e };
      delete copy.at;
      const json = JSON.stringify(copy);
      return json
        .replace(/\/[^"]*logeq-[A-Za-z0-9]+/g, "<workspace>")
        .replace(/"(m|a|r)_\d+(_\d+)?"/g, '"<id>"');
    })
    .join("\n");
}

const headless = await runOnce(false);
const withUi = await runOnce(true);

const a = normalise(headless);
const b = normalise(withUi);

console.log(`headless: ${headless.length} events`);
console.log(`with UI:  ${withUi.length} events`);

if (a === b) {
  console.log("\nok   identical event logs — the UI records nothing and changes nothing");
  process.exit(0);
}

const la = a.split("\n"), lb = b.split("\n");
console.log("\nFAIL logs differ:");
for (let i = 0; i < Math.max(la.length, lb.length); i++) {
  if (la[i] !== lb[i]) {
    console.log(`  line ${i + 1}`);
    console.log(`    headless: ${la[i] ?? "(missing)"}`);
    console.log(`    with UI:  ${lb[i] ?? "(missing)"}`);
    break;
  }
}
process.exit(1);
