/**
 * A session must survive the process that made it.
 *
 * Resume is the only feature here whose failure loses work rather than just
 * misbehaving, and it had never been run end to end. The checks are what the
 * next turn depends on: the prior conversation reaches the model, sequence
 * numbers continue rather than restarting, one log holds both runs, and a
 * session recorded somewhere else is refused rather than replayed against the
 * wrong tree.
 */
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/core/bus.ts";
import { EventLog } from "../src/core/log.ts";
import { AgentLoop } from "../src/core/loop.ts";
import { LocalExecutor } from "../src/exec/local.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";
import { resume, listSessions } from "../src/core/session.ts";
import type { ConvoMessage } from "../src/core/projection.ts";
import type { ModelChunk, ModelClient } from "../src/model/client.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** Records what it was asked, so we can see what the second run was given. */
class Recorder implements ModelClient {
  readonly name = "scripted";
  readonly facts = { contextWindow: 16_384, cacheThreshold: null, supportsTools: true };
  seen: ConvoMessage[][] = [];
  constructor(private readonly reply: string) {}
  async *stream(messages: ConvoMessage[]): AsyncIterable<ModelChunk> {
    this.seen.push(messages);
    yield { kind: "text", text: this.reply };
    yield { kind: "done", usage: { input: 10, output: 5 } };
  }
}

const ws = mkdtempSync(join(tmpdir(), "resume-"));
writeFileSync(join(ws, "note.txt"), "hello\n");
const sessionsDir = join(ws, ".sessions");

function makeLoop(bus: EventBus, model: ModelClient, sessionId: string, history?: any) {
  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);
  return new AgentLoop({
    sessionId,
    bus,
    model,
    tools,
    policy: new PermissionPolicy(),
    toolContext: { exec: new LocalExecutor(ws, { sandbox: false }), opts: { cwd: ws } },
    ask: async () => ({ kind: "allow", scope: "once" }),
    ...(history ? { history } : {}),
  });
}

// ---- first run -------------------------------------------------------------
const sessionId = "abc12345";
const log1 = new EventLog(sessionsDir, sessionId);
log1.writeMeta({ sessionId, startedAt: new Date().toISOString(), cwd: ws, model: "scripted" });
const bus1 = new EventBus();
bus1.on((e) => log1.append(e));
const first = new Recorder("The note says hello.");
await makeLoop(bus1, first, sessionId).run("what does the note say?");

const afterFirst = log1.read();
const lastSeq = afterFirst.events.at(-1)!.seq;
check("first run recorded events", afterFirst.events.length > 0, `${afterFirst.events.length}`);

// ---- resume ----------------------------------------------------------------
const restored = resume(sessionId, sessionsDir, ws);
check("resume loads the prior events", restored.history.length === afterFirst.events.length,
  `${restored.history.length} vs ${afterFirst.events.length}`);
check("resume continues the sequence", restored.bus.seq === lastSeq + 1,
  `bus at ${restored.bus.seq}, log ended at ${lastSeq}`);

restored.bus.on((e) => restored.log.append(e));
const second = new Recorder("It still says hello.");
await makeLoop(restored.bus, second, sessionId, restored.history).run("and now?");

// What did the second run actually see?
const given = second.seen[0] ?? [];
const texts = given.map((m) => m.text);
check("the earlier question reached the model",
  texts.some((t) => t.includes("what does the note say")), JSON.stringify(texts).slice(0, 90));
check("the earlier answer reached the model",
  texts.some((t) => t.includes("The note says hello")), JSON.stringify(texts).slice(0, 90));
check("the new question is present", texts.some((t) => t.includes("and now?")));

// ---- the log ---------------------------------------------------------------
const afterSecond = EventLog.readFile(join(sessionsDir, `${sessionId}.jsonl`));
check("one log holds both runs", afterSecond.events.length > afterFirst.events.length,
  `${afterFirst.events.length} -> ${afterSecond.events.length}`);
const seqs = afterSecond.events.map((e) => e.seq);
check("sequence numbers stay strictly increasing",
  seqs.every((n, i) => i === 0 || n > seqs[i - 1]!), JSON.stringify(seqs.slice(-6)));
check("exactly one session_meta line",
  readFileSync(join(sessionsDir, `${sessionId}.jsonl`), "utf8").split("\n").filter((l) => l.includes("session_meta")).length === 1);
check("the session is listed", listSessions(sessionsDir).some((s) => s.id === sessionId));

// ---- the wrong tree --------------------------------------------------------
let refused = false;
try { resume(sessionId, sessionsDir, mkdtempSync(join(tmpdir(), "other-"))); }
catch { refused = true; }
check("resuming against a different workspace is refused", refused);

// ---- the command line ------------------------------------------------------
//
// Everything above drives `resume()` and the loop in process, which is why it
// stayed green while `agent --resume` was broken: the argument handling in
// front of it was never run. These spawn the real CLI.

const cli = new URL("../src/cli/headless.ts", import.meta.url).pathname;
const agent = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["run", cli, ...args], {
    cwd: ws,
    encoding: "utf8",
    env: { ...process.env, MODEL: "scripted-not-used" },
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
};
/** A raw throw reaching the user is the failure these replaced. */
const crashed = (out: string) => /ENOENT|\bat [a-zA-Z]+ \(|Bun v\d/.test(out);

const noId = agent("--resume", "--yes");
check("--resume with no id lists the sessions instead of crashing",
  noId.code === 0 && noId.out.includes(sessionId) && !crashed(noId.out),
  `exit ${noId.code}: ${noId.out.slice(0, 160)}`);
// Checking for the old raw ENOENT path would pass now that the message is
// readable, so this checks the flag is never treated as an id at all.
check("and it does not read the next flag as a session id",
  !/no session\s+--/.test(noId.out), noId.out.slice(0, 160));

const trailing = agent("--yes", "--resume");
check("--resume as the last argument lists too, rather than silently starting a new session",
  trailing.code === 0 && trailing.out.includes(sessionId) && !crashed(trailing.out),
  `exit ${trailing.code}: ${trailing.out.slice(0, 160)}`);

const bad = agent("--resume", "nosuchid", "hello", "--yes");
check("an unknown id is named and refused, without a stack trace",
  bad.code === 1 && bad.out.includes("nosuchid") && !crashed(bad.out),
  `exit ${bad.code}: ${bad.out.slice(0, 160)}`);
check("and it still shows what there is to resume", bad.out.includes(sessionId));

const sizeBefore = statSync(join(sessionsDir, `${sessionId}.jsonl`)).size;
const noPrompt = agent("--resume", sessionId, "--yes");
check("--resume with no instruction is a usage error, not a turn on an empty prompt",
  noPrompt.code === 1 && noPrompt.out.includes("usage"), `exit ${noPrompt.code}: ${noPrompt.out.slice(0, 160)}`);
check("and it appended nothing to the log",
  statSync(join(sessionsDir, `${sessionId}.jsonl`)).size === sizeBefore);

const bare = agent();
check("no arguments at all is a usage error", bare.code === 1 && bare.out.includes("usage"),
  `exit ${bare.code}: ${bare.out.slice(0, 120)}`);

process.exit(failures ? 1 : 0);
