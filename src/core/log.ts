import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, SessionMeta } from "./events.ts";
import { PROTOCOL_VERSION } from "./events.ts";

/**
 * Append-only JSONL event log. The source of truth for a session.
 *
 * Everything a client shows -- the transcript, the context window sent to the
 * model, the audit trail -- is a projection over this file. Nothing is ever
 * rewritten in place, which is what makes compaction reversible.
 */
export class EventLog {
  readonly path: string;

  constructor(readonly dir: string, readonly sessionId: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${sessionId}.jsonl`);
  }

  writeMeta(meta: Omit<SessionMeta, "kind" | "protocolVersion">): void {
    if (existsSync(this.path)) return;
    const line: SessionMeta = {
      kind: "session_meta",
      protocolVersion: PROTOCOL_VERSION,
      ...meta,
    };
    appendFileSync(this.path, JSON.stringify(line) + "\n");
  }

  append(e: AgentEvent): void {
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }

  read(): { meta: SessionMeta; events: AgentEvent[] } {
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const first = lines.shift();
    if (!first) throw new Error(`empty log: ${this.path}`);

    const meta = JSON.parse(first) as SessionMeta;
    if (meta.kind !== "session_meta") {
      throw new Error(`first line is not session_meta: ${this.path}`);
    }
    if (meta.protocolVersion > PROTOCOL_VERSION) {
      throw new Error(
        `log written by protocol v${meta.protocolVersion}, this build speaks v${PROTOCOL_VERSION}`,
      );
    }
    return { meta, events: lines.map((l) => JSON.parse(l) as AgentEvent) };
  }

  static readFile(path: string): { meta: SessionMeta; events: AgentEvent[] } {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const meta = JSON.parse(lines[0]!) as SessionMeta;
    return { meta, events: lines.slice(1).map((l) => JSON.parse(l) as AgentEvent) };
  }
}
