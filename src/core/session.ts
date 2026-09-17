import { readdirSync, existsSync } from "node:fs";
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
): { bus: EventBus; log: EventLog; meta: SessionMeta; history: AgentEvent[] } {
  const log = new EventLog(dir, sessionId);
  const { meta, events } = log.read();
  const bus = new EventBus();
  bus.resumeFrom((events.at(-1)?.seq ?? -1) + 1);
  return { bus, log, meta, history: events };
}

function isUser(events: AgentEvent[], id: string): boolean {
  return events.some((e) => e.type === "message.started" && e.id === id && e.role === "user");
}
