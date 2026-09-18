/**
 * What a call did to the workspace has to reach the screen.
 *
 * `file.changed` was a first-class event emitted by the loop and discarded by
 * the view model: zero cases in `model.ts`, so it fell through to `default`.
 * The consequence was that a read and a write rendered identically -- both a
 * green tick over a bold verb -- and the one question a reader has scrolling
 * back a session, what did it change in my files, was answerable only by
 * reading the verb.
 *
 * The emitter also called every write `modified`, including one that created
 * the file, so the field had one value and could not carry the distinction.
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/core/bus.ts";
import { AgentLoop } from "../src/core/loop.ts";
import { LocalExecutor } from "../src/exec/local.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";
import { reduce, initialState, type ViewItem, type ViewState } from "../src/ui/model.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelChunk, ModelClient } from "../src/model/client.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ws = mkdtempSync(join(tmpdir(), "changed-"));
writeFileSync(join(ws, "existing.txt"), "already here\n");

/** Calls the tools it was given, once each, then stops. */
class Scripted implements ModelClient {
  readonly name = "scripted";
  readonly facts = { contextWindow: 16_384, cacheThreshold: null, supportsTools: true };
  #turn = 0;
  constructor(private readonly calls: { name: string; args: unknown }[]) {}
  async *stream(): AsyncIterable<ModelChunk> {
    const call = this.calls[this.#turn++];
    if (!call) {
      yield { kind: "text", text: "done" };
      yield { kind: "done", usage: { input: 1, output: 1 } };
      return;
    }
    yield { kind: "tool_call", call: { id: `c${this.#turn}`, name: call.name, args: call.args } };
    yield { kind: "done", usage: { input: 1, output: 1 } };
  }
}

async function runCalls(calls: { name: string; args: unknown }[]): Promise<AgentEvent[]> {
  const bus = new EventBus();
  const seen: AgentEvent[] = [];
  bus.on((e) => seen.push(e));
  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);
  await new AgentLoop({
    sessionId: "s",
    bus,
    model: new Scripted(calls),
    tools,
    policy: new PermissionPolicy(),
    toolContext: { exec: new LocalExecutor(ws, { sandbox: false }), opts: { cwd: ws } },
    ask: async () => ({ kind: "allow", scope: "once" }),
  }).run("do it");
  return seen;
}

// ---- the emitter -----------------------------------------------------------

const events = await runCalls([
  { name: "write_file", args: { path: "brand-new.txt", content: "hello\n" } },
  { name: "write_file", args: { path: "existing.txt", content: "changed\n" } },
  { name: "read_file", args: { path: "existing.txt" } },
]);

const changes = events.filter((e) => e.type === "file.changed");
check("a write emits file.changed", changes.length === 2, `${changes.length} event(s)`);

const created = changes.find((e) => e.type === "file.changed" && e.path.endsWith("brand-new.txt"));
const modified = changes.find((e) => e.type === "file.changed" && e.path.endsWith("existing.txt"));
check("a file that did not exist is reported as created",
  created?.type === "file.changed" && created.change === "created",
  JSON.stringify(created));
check("and one that did is reported as modified",
  modified?.type === "file.changed" && modified.change === "modified",
  JSON.stringify(modified));
check("the write actually happened", existsSync(join(ws, "brand-new.txt")));
check("a read emits none", changes.length === 2);

// It is emitted before the result, which is what makes the attachment below
// land on a tool that is still running rather than on the next one.
const firstChange = events.findIndex((e) => e.type === "file.changed");
const firstResult = events.findIndex((e) => e.type === "tool.result");
check("file.changed arrives before its tool.result", firstChange < firstResult,
  `change at ${firstChange}, result at ${firstResult}`);

// ---- the view model --------------------------------------------------------

const state = events.reduce<ViewState>((acc, e) => reduce(acc, e), initialState);
const toolItems = state.items.filter((i): i is Extract<ViewItem, { kind: "tool" }> => i.kind === "tool");
check("every call is on screen", toolItems.length === 3, `${toolItems.length}`);

const withChanges = toolItems.filter((t) => (t.changed?.length ?? 0) > 0);
check("only the writes carry changes", withChanges.length === 2,
  JSON.stringify(toolItems.map((t) => [t.name, t.changed?.length ?? 0])));
// Read through optionals rather than asserting the shape. An indexing throw
// here ends the run and reports fewer assertions than it has, which reads far
// too much like a pass -- the same hazard the mutation harness guards against.
const first = withChanges[0]?.changed?.[0];
const second = withChanges[1]?.changed?.[0];
check("each write carries its own path, not the other's",
  first?.path.endsWith("brand-new.txt") === true
    && second?.path.endsWith("existing.txt") === true,
  JSON.stringify(withChanges.map((t) => t.changed)));
check("with the created/modified distinction intact",
  first?.change === "created" && second?.change === "modified",
  JSON.stringify([first, second]));
check("the read carries none",
  toolItems.find((t) => t.name === "read_file")?.changed === undefined);

console.log(failures === 0 ? "\nwhat a call changed reaches the view model" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
