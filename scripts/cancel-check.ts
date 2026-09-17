/**
 * Esc during a command must kill the whole process tree and keep what the
 * command already printed.
 *
 * The tree part is the half that fails quietly: killing the shell leaves its
 * children running, and nothing on screen says so. This spawns a grandchild
 * that outlives a naive kill and then checks it is actually gone.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalExecutor } from "../src/exec/local.ts";
import { EventBus } from "../src/core/bus.ts";
import { AgentLoop } from "../src/core/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelChunk, ModelClient } from "../src/model/client.ts";


const ws = mkdtempSync(join(tmpdir(), "cancel-"));
const exec = new LocalExecutor(ws, { sandbox: false });
const opts = { cwd: ws };

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A grandchild that records its pid and would outlive the shell.
const pidFile = join(ws, "child.pid");
const controller = new AbortController();
let output = "";

const started = Date.now();
const runPromise = exec.run(
  `echo early; ( echo $$ > ${pidFile}; sleep 30 ) & sleep 30; echo late`,
  { ...opts, signal: controller.signal },
  (c) => { output += c.text; },
);

await new Promise((r) => setTimeout(r, 700));
check("partial output arrived before the cancel", output.includes("early"), JSON.stringify(output));
const childPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
check("a grandchild process exists to test against", childPid > 0 && alive(childPid), `pid ${childPid}`);

controller.abort();
const result = await runPromise;
const elapsed = Date.now() - started;

check("run resolved promptly after cancel", elapsed < 5000, `${elapsed}ms`);
check("result reports killed", result.killed, JSON.stringify(result));
check("output already streamed is kept", output.includes("early"));
check("output after the cancel point is absent", !output.includes("late"));

// SIGTERM propagates through the group; give it a moment to land.
await new Promise((r) => setTimeout(r, 600));
check("the grandchild was killed too", childPid > 0 && !alive(childPid), `pid ${childPid} still alive`);

// ---------------------------------------------------------------------------
// The same thing through the loop: the events a client sees, and what the
// model is told about a command that was interrupted.
// ---------------------------------------------------------------------------

class OneLongCommand implements ModelClient {
  readonly name = "scripted";
  readonly facts = { contextWindow: 16_384, cacheThreshold: null, supportsTools: true };
  #turn = 0;
  async *stream(): AsyncIterable<ModelChunk> {
    if (this.#turn++ === 0) {
      yield { kind: "tool_call", call: { id: "c1", name: "shell", args: { command: "echo starting; sleep 30; echo finished" } } };
      yield { kind: "done" };
    } else {
      yield { kind: "text", text: "stopped" };
      yield { kind: "done" };
    }
  }
}

const ws2 = mkdtempSync(join(tmpdir(), "cancel-loop-"));
const events: AgentEvent[] = [];
const bus = new EventBus();
bus.on((e) => events.push(e));
const tools = new ToolRegistry();
for (const t of builtinTools) tools.register(t);

const loop = new AgentLoop({
  sessionId: "cancel",
  bus,
  model: new OneLongCommand(),
  tools,
  policy: new PermissionPolicy(),
  toolContext: { exec: new LocalExecutor(ws2, { sandbox: false }), opts: { cwd: ws2 } },
  ask: async () => ({ kind: "allow", scope: "once" }),
});

const runningLoop = loop.run("run something slow");
await new Promise((r) => setTimeout(r, 900));
loop.cancel();
const state = await runningLoop;

const completed = events.find((e) => e.type === "command.completed");
const toolResult = events.find((e) => e.type === "tool.result");
const resultText = String((toolResult as { result?: unknown } | undefined)?.result ?? "");

console.log();
check("loop ends as cancelled", state === "cancelled", state);
check("command.completed reports killed", completed?.type === "command.completed" && completed.killed);
check("the model is given the partial output", resultText.includes("starting"), resultText.slice(0, 60));
check("the model is not given output from after the cancel", !resultText.includes("finished"));
check("the result says it was cancelled", /cancelled/i.test(resultText), resultText.slice(0, 80));

process.exit(failures ? 1 : 0);
