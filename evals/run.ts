/**
 * Runs each fixture against a fresh copy of its repository and reports whether
 * the agent actually did the job.
 *
 * Approvals are auto-allowed here: the approval path is covered by the gate
 * scripts, and a suite that blocks on a prompt cannot run unattended.
 */

import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { EventBus } from "../src/core/bus.ts";
import { AgentLoop } from "../src/core/loop.ts";
import { LocalExecutor } from "../src/exec/local.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";
import { OllamaClient } from "../src/model/ollama.ts";
import { SYSTEM_PROMPT } from "../src/core/prompt.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { Fixture, Transcript, VerifyContext } from "./types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

type Args = {
  fast: boolean;
  repeats: number;
  only?: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const val = (flag: string) => {
    const i = a.findIndex((x) => x === flag || x.startsWith(flag + "="));
    if (i === -1) return undefined;
    return a[i]!.includes("=") ? a[i]!.split("=")[1] : a[i + 1];
  };
  return {
    fast: a.includes("--fast"),
    repeats: Number(val("--repeats") ?? 1),
    only: val("--only"),
    model: val("--model") ?? process.env.MODEL ?? "qwen3:8b",
    maxTurns: Number(val("--max-turns") ?? 20),
    // Ten minutes is far past any fixture that is working and far short of a
    // sweep nobody is watching. Settable so the gate can drive the timeout
    // itself rather than waiting one out.
    timeoutMs: Number(val("--timeout") ?? process.env.EVAL_TIMEOUT_MS ?? 600_000),
  };
}

async function loadFixtures(args: Args): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const name of readdirSync(FIXTURES)) {
    const file = join(FIXTURES, name, "fixture.ts");
    if (!existsSync(file)) continue;
    const mod = (await import(file)) as Fixture;
    if (args.only && mod.meta.name !== args.only) continue;
    if (args.fast && !mod.meta.fast) continue;
    out.push(mod);
  }
  return out.sort((x, y) => x.meta.name.localeCompare(y.meta.name));
}

function sh(command: string, cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function runOnce(fixture: Fixture, args: Args) {
  const repo = await mkdtemp(join(tmpdir(), `eval-${fixture.meta.name}-`));
  await cp(join(FIXTURES, fixture.meta.name, "repo"), repo, { recursive: true });

  const events: AgentEvent[] = [];
  const bus = new EventBus();
  bus.on((e) => events.push(e));

  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);

  const loop = new AgentLoop({
    sessionId: randomUUID().slice(0, 8),
    bus,
    model: new OllamaClient(args.model),
    tools,
    policy: new PermissionPolicy(),
    // Sandbox off: fixtures run in a temp dir and several need to spawn bun.
    toolContext: { exec: new LocalExecutor(repo, { sandbox: false }), opts: { cwd: repo } },
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: args.maxTurns,
    ask: async () => ({ kind: "allow", scope: "once" }),
  });

  const started = Date.now();
  // A wedged run used to hang the whole sweep, which is worse than scoring it
  // wrong: nothing is reported at all and there is nothing to read afterwards.
  // `cancel` is the loop's own path and returns "cancelled", so the verdict
  // rule below already refuses it; the flag only exists to say which of the
  // two happened.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; loop.cancel(); }, args.timeoutMs);
  let state;
  try {
    state = await loop.run(fixture.task);
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Date.now() - started;

  const toolCalls: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "tool.started") toolCalls[e.name] = (toolCalls[e.name] ?? 0) + 1;
  }
  const transcript: Transcript = {
    events,
    finalText: events
      .filter((e): e is Extract<AgentEvent, { type: "message.completed" }> => e.type === "message.completed")
      .map((e) => e.text)
      .join("\n"),
    turns: events.filter((e) => e.type === "turn.started").length,
    toolCalls,
    state,
  };

  const ctx: VerifyContext = {
    repo,
    transcript,
    run: (c) => sh(c, repo),
    read: (p) => readFile(join(repo, p), "utf8"),
  };

  let result;
  try {
    result = await fixture.verify(ctx);
  } catch (err) {
    result = { ok: false, reason: `verifier threw: ${(err as Error).message}` };
  }

  // A run that did not finish is not a pass, whatever the repo looks like
  // afterwards. Verifiers decide on the repo and the transcript, and the ones
  // phrased as "nothing bad happened" are satisfied by an agent that never
  // acted: `workspace-escape` scored green in zero seconds against a model
  // name that does not exist, because nothing escaped and nothing was
  // fabricated. Asserted here rather than in each verifier, since the next
  // fixture written in that shape would have to remember on its own.
  if (timedOut) {
    result = { ok: false, reason: `killed at the ${args.timeoutMs / 1000}s timeout: ${result.reason}` };
  } else if (result.ok && state !== "completed") {
    result = { ok: false, reason: `run ended ${state}: ${result.reason}` };
  }

  await rm(repo, { recursive: true, force: true });
  return { ...result, elapsedMs, transcript };
}

const args = parseArgs();
const fixtures = await loadFixtures(args);
if (!fixtures.length) {
  console.error("no fixtures matched");
  process.exit(1);
}

console.log(`model ${args.model}  ·  ${fixtures.length} fixtures  ·  ${args.repeats} run(s) each\n`);

let passed = 0, total = 0;
for (const f of fixtures) {
  const runs = [];
  for (let i = 0; i < args.repeats; i++) runs.push(await runOnce(f, args));
  const ok = runs.filter((r) => r.ok).length;
  passed += ok;
  total += runs.length;

  const tag = f.meta.kind === "trap" ? "trap" : "cap ";
  const rate = args.repeats > 1 ? ` ${ok}/${args.repeats}` : ok ? " pass" : " FAIL";
  const avg = Math.round(runs.reduce((s, r) => s + r.elapsedMs, 0) / runs.length / 1000);
  const turns = Math.round(runs.reduce((s, r) => s + r.transcript.turns, 0) / runs.length);
  console.log(`${ok === runs.length ? "✓" : "✗"} ${tag} ${f.meta.name.padEnd(28)}${rate}  ${avg}s  ${turns} turns`);
  for (const r of runs) {
    if (!r.ok) console.log(`      ${r.reason}`);
  }
}

console.log(`\n${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
