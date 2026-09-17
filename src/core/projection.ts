import type { AgentEvent, ReasoningPayload, Role } from "./events.ts";

/** One turn as the model needs to see it. */
export type ConvoMessage = {
  readonly seq: number;
  readonly role: Role;
  readonly text: string;
  /** Replayed verbatim on the next request. Provider-owned, never rewritten. */
  readonly reasoning?: ReasoningPayload;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
};

export type Projection = {
  readonly messages: ConvoMessage[];
  /** Seqs currently excluded by compaction, with the summary that replaced them. */
  readonly dropped: { seqs: number[]; summary: string; reason: string }[];
};

/**
 * Rebuild the conversation from the log.
 *
 * Compaction is applied here, as a projection decision -- the underlying
 * events are never removed from the file, so a restore event simply
 * un-hides them. That is what makes "show me what was dropped, put it back"
 * a read of existing data rather than a recovery feature.
 */
export function project(events: AgentEvent[]): Projection {
  const messages: ConvoMessage[] = [];
  const dropped: { seqs: number[]; summary: string; reason: string }[] = [];
  const hidden = new Set<number>();

  let pendingReasoning: ReasoningPayload | undefined;

  for (const e of events) {
    switch (e.type) {
      case "message.completed": {
        const role: Role = roleOfMessage(events, e.id);
        messages.push({
          seq: e.seq,
          role,
          text: e.text,
          ...(role === "assistant" && pendingReasoning
            ? { reasoning: pendingReasoning }
            : {}),
        });
        pendingReasoning = undefined;
        break;
      }
      case "reasoning.completed":
        pendingReasoning = e.payload;
        break;
      case "tool.ended":
        messages.push({
          seq: e.seq,
          role: "assistant",
          text: "",
          toolCallId: e.callId,
          toolName: nameOfCall(events, e.callId),
          toolArgs: e.args,
          ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
        });
        pendingReasoning = undefined;
        break;
      case "tool.result":
        messages.push({
          seq: e.seq,
          role: "tool",
          text: typeof e.result === "string" ? e.result : JSON.stringify(e.result),
          toolCallId: e.callId,
          toolName: nameOfCall(events, e.callId),
        });
        break;
      case "context.compacted":
        for (const s of e.droppedSeqs) hidden.add(s);
        dropped.push({ seqs: e.droppedSeqs, summary: e.summary, reason: e.reason });
        break;
      case "context.restored":
        for (const s of e.restoredSeqs) hidden.delete(s);
        break;
    }
  }

  return { messages: messages.filter((m) => !hidden.has(m.seq)), dropped };
}

function roleOfMessage(events: AgentEvent[], id: string): Role {
  for (const e of events) {
    if (e.type === "message.started" && e.id === id) return e.role;
  }
  return "assistant";
}

function nameOfCall(events: AgentEvent[], callId: string): string | undefined {
  for (const e of events) {
    if (e.type === "tool.started" && e.callId === callId) return e.name;
  }
  return undefined;
}
