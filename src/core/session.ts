import { readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "./log.ts";
import { EventBus } from "./bus.ts";
import type { AgentEvent, SessionMeta } from "./events.ts";

/**
 * Session discovery and resume.
 *
 * Resume is a read of the log plus a bus whose counter continues where the
 * file left off. There is no separate "session state" to restore, because
 * there is no state outside the log.
 */

export type SessionSummary = {
  readonly id: string;
  readonly meta: SessionMeta;
  readonly events: number;
  readonly lastAt: string;
  readonly firstPrompt: string;
};

/**
 * One row of the session list.
 *
 * Shared because two commands print it -- `sessions list` and the list that
 * `agent --resume` shows when it is given no id -- and a resume list that
 * formats ids differently from the list you copied the id out of is worse than
 * no list at all.
 */
export function sessionLine(s: SessionSummary): string {
  return `${s.id}  ${s.lastAt.slice(0, 19)}  ${String(s.events).padStart(5)} events  ${s.firstPrompt.slice(0, 50)}`;
}

export function listSessions(dir = ".sessions"): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const { meta, events } = EventLog.readFile(join(dir, f));
      const firstUser = events.find(
        (e) => e.type === "message.completed" && isUser(events, e.id),
      );
      out.push({
        id: meta.sessionId,
        meta,
        events: events.length,
        lastAt: events.at(-1)?.at ?? meta.startedAt,
        firstPrompt:
          firstUser && firstUser.type === "message.completed" ? firstUser.text : "(empty)",
      });
    } catch {
      // A half-written log is skipped, not fatal.
    }
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function resume(
  sessionId: string,
  dir = ".sessions",
  workspace = process.cwd(),
): { bus: EventBus; log: EventLog; meta: SessionMeta; history: AgentEvent[] } {
  const log = new EventLog(dir, sessionId);
  // The constructor only makes the directory, so a wrong id reached `read()`
  // and surfaced as a raw ENOENT stack trace from inside the log reader.
  if (!existsSync(log.path)) {
    throw new Error(`no session ${sessionId} in ${dir}/`);
  }
  const { meta, events } = log.read();
  if (!sameDir(meta.cwd, workspace)) {
    // The log records tool results describing files this tree may not have.
    throw new Error(
      `session ${sessionId} was recorded in ${meta.cwd}, not ${workspace}. Resume it there.`,
    );
  }
  const bus = new EventBus();
  bus.resumeFrom((events.at(-1)?.seq ?? -1) + 1);
  return { bus, log, meta, history: events };
}

/**
 * The same directory reached by a different path is the same workspace.
 *
 * Resolve first, compare second. A string comparison refused a session the
 * workspace had recorded itself: macOS reaches `/tmp` and `/var` through
 * symlinks, so `process.cwd()` reports `/private/var/...` for a session whose
 * log says `/var/...`. Any symlinked checkout does the same thing.
 */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // A recorded workspace that no longer exists is not this one.
    return false;
  }
}

function isUser(events: AgentEvent[], id: string): boolean {
  return events.some((e) => e.type === "message.started" && e.id === id && e.role === "user");
}
