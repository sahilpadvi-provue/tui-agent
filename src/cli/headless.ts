/**
 * Stage 1 gate: the agent completes a real task with no UI attached.
 *
 * Nothing here renders. It subscribes to the bus and prints, exactly as any
 * other client would -- which is the point: if this works, the loop is
 * genuinely independent of the terminal UI, and it cannot quietly stop being
 * so once the UI exists.
 */
import { randomUUID } from "node:crypto";
import { EventBus } from "../core/bus.ts";
import { EventLog } from "../core/log.ts";
import { AgentLoop } from "../core/loop.ts";
import { LocalExecutor } from "../exec/local.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { builtinTools } from "../tools/builtin.ts";
import { PermissionPolicy, radiusLines } from "../permissions/policy.ts";
import { OllamaClient } from "../model/ollama.ts";
import { SYSTEM_PROMPT } from "../core/prompt.ts";
import { listSessions, resume, sessionLine } from "../core/session.ts";

const autoApprove = process.argv.includes("--yes");
const noSandbox = process.argv.includes("--no-sandbox");
const wantsResume = process.argv.some((a) => a === "--resume" || a.startsWith("--resume="));
const resumeId = argValue("--resume");

// `--resume` with nothing after it asks which session, so answer that rather
// than guessing. It used to read the next flag as the id and die on an ENOENT
// for `.sessions/--yes.jsonl`, or, with `--resume` last, silently start a new
// session -- the worst of the three, because it looks like it resumed.
if (wantsResume && !resumeId) {
  process.exit(printResumable() ? 0 : 1);
}

const prompt = process.argv
  .slice(2)
  .join(" ")
  .replace(/\s*--yes\s*/, " ")
  .replace(/\s*--no-sandbox\s*/, " ")
  .replace(/\s*--resume(=|\s+)\S+\s*/, " ")
  .trim();

// An empty prompt used to reach the loop, which ran a turn on nothing and
// answered the previous question again. That reads as a resume that ignored
// the instruction rather than as a command with a missing argument.
if (!prompt) {
  console.error(
    wantsResume
      ? `usage: bun run agent --resume ${resumeId} "<instruction>"`
      : 'usage: bun run agent "<task>" [--yes] [--no-sandbox] [--resume <id>]',
  );
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i === -1) return undefined;
  const a = process.argv[i]!;
  if (a.includes("=")) return a.split("=")[1];
  const next = process.argv[i + 1];
  // A flag is not a value.
  return next === undefined || next.startsWith("-") ? undefined : next;
}

/** The sessions there are to resume. False when there are none. */
function printResumable(): boolean {
  const sessions = listSessions();
  if (!sessions.length) {
    console.error("no sessions in .sessions/ to resume");
    return false;
  }
  console.log("\nresume one of these:\n");
  for (const s of sessions.slice(0, 15)) console.log(`  ${sessionLine(s)}`);
  if (sessions.length > 15) console.log(`  \u2026 ${sessions.length - 15} older`);
  console.log('\n  bun run agent --resume <id> "<instruction>"');
  return true;
}

const cwd = process.cwd();
const model = new OllamaClient(process.env.MODEL ?? "qwen3:8b");

let prior: ReturnType<typeof resume> | undefined;
if (resumeId) {
  try {
    prior = resume(resumeId);
  } catch (e) {
    console.error(`\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`);
    printResumable();
    process.exit(1);
  }
}
const sessionId = prior?.meta.sessionId ?? randomUUID().slice(0, 8);
const bus = prior?.bus ?? new EventBus();
const log = prior?.log ?? new EventLog(".sessions", sessionId);

if (prior) {
  console.log(`\x1b[2mresumed ${sessionId}: ${prior.history.length} prior events\x1b[0m`);
} else {
  log.writeMeta({ sessionId, startedAt: new Date().toISOString(), cwd, model: model.name });
}
bus.on((e) => log.append(e));

// A client. Prints; decides nothing.
bus.on((e) => {
  switch (e.type) {
    case "context.compacted":
      console.log(`\x1b[33m[compacted] ${e.droppedSeqs.length} events hidden — ${e.summary}\x1b[0m`);
      console.log(`\x1b[2m           ${e.reason}  (restore with: bun run sessions restore ${sessionId} ${e.droppedSeqs.join(",")})\x1b[0m`);
      break;
    case "message.delta":
      process.stdout.write(e.text);
      break;
    case "message.completed":
      process.stdout.write("\n");
      break;
    case "reasoning.started":
      process.stdout.write("\x1b[2m[thinking]\x1b[0m ");
      break;
    case "reasoning.completed":
      process.stdout.write("\x1b[2m[/thinking]\x1b[0m\n");
      break;
    case "tool.ended":
      console.log(`\x1b[36m-> ${JSON.stringify(e.args)}\x1b[0m`);
      break;
    case "tool.started":
      process.stdout.write(`\x1b[36m[tool] ${e.name}\x1b[0m `);
      break;
    case "tool.result":
      console.log(
        e.ok
          ? `\x1b[32m<- ok\x1b[0m ${preview(e.result)}`
          : `\x1b[31m<- ${preview(e.result)}\x1b[0m`,
      );
      break;
    case "command.output":
      process.stdout.write(`\x1b[2m${e.chunk}\x1b[0m`);
      break;
    case "permission.requested":
      console.log(`\x1b[33m[approve] ${e.tool}  ${radiusLines(e.blastRadius).join("  \u00b7  ")}\x1b[0m`);
      break;
    case "error":
      console.error(`\x1b[31m[error] ${e.message}\x1b[0m`);
      break;
    case "turn.completed":
      if (e.usage) {
        console.log(`\x1b[2m[turn ${e.turn}] ${e.usage.input} in / ${e.usage.output} out\x1b[0m`);
      }
      break;
  }
});

const exec = new LocalExecutor(cwd, { sandbox: !noSandbox, allowNetwork: true });
console.log(`\x1b[2msandbox: ${exec.describeSandbox()}\x1b[0m`);
const tools = new ToolRegistry();
for (const t of builtinTools) tools.register(t);

const loop = new AgentLoop({
  sessionId,
  bus,
  model,
  tools,
  policy: new PermissionPolicy(),
  toolContext: { exec, opts: { cwd } },
  systemPrompt: SYSTEM_PROMPT,
  checkpoints: true,
  history: prior?.history,
  ask: async (req) => {
    if (autoApprove) return { kind: "allow", scope: "once" };
    const answer = prompt2(`approve ${req.tool}? [y/N] `);
    return answer.toLowerCase().startsWith("y")
      ? { kind: "allow", scope: "once" }
      : { kind: "deny", reason: "declined at prompt" };
  },
});

process.on("SIGINT", () => {
  console.log("\n\x1b[33m[cancelled]\x1b[0m");
  loop.cancel();
});

const state = await loop.run(prompt);
const verdict = state === "completed" ? "agent stopped (no further tool calls)" : state;
console.log(`\n\x1b[2msession ${sessionId} -> ${verdict}  (${log.path})\x1b[0m`);
console.log(`\x1b[2mresume: bun run agent --resume ${sessionId} "<next instruction>"\x1b[0m`);
process.exit(state === "completed" ? 0 : 1);

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const flat = s.replace(/\n/g, " ");
  return flat.length > 100 ? flat.slice(0, 100) + "..." : flat;
}

function prompt2(q: string): string {
  process.stdout.write(q);
  const buf = new Uint8Array(1024);
  const n = require("node:fs").readSync(0, buf, 0, 1024, null);
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}
