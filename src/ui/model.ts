import type { AgentEvent, BlastRadius, RunState, TokenUsage } from "../core/events.ts";

/**
 * The view model: a fold over the event stream.
 *
 * The UI holds no other state and never reads from the runtime. Everything
 * on screen is derived from events, which is why the same fold would drive
 * a web client unchanged.
 */

export type ViewItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; chars: number; done: boolean }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args?: unknown;
      output: string;
      result?: string;
      ok?: boolean;
      running: boolean;
    }
  | { kind: "error"; text: string }
  | { kind: "compaction"; dropped: number; summary: string };

export type ViewState = {
  items: ViewItem[];
  status: RunState;
  usage: { input: number; output: number };
  pending?: { requestId: string; tool: string; radius: BlastRadius };
};

export const initialState: ViewState = {
  items: [],
  status: "submitted",
  usage: { input: 0, output: 0 },
};

const MAX_TOOL_OUTPUT = 4000;

export function reduce(s: ViewState, e: AgentEvent): ViewState {
  const items = s.items;
  switch (e.type) {
    case "message.started":
      if (e.role === "user") return s; // text arrives on completed
      return { ...s, items: [...items, { kind: "assistant", id: e.id, text: "", streaming: true }] };

    case "message.delta":
      return { ...s, items: patch(items, (i) => i.kind === "assistant" && i.id === e.id, (i) => ({ ...i, text: (i as any).text + e.text })) };

    case "message.completed": {
      const existing = items.some((i) => (i.kind === "assistant" || i.kind === "user") && (i as any).id === e.id);
      if (!existing) return { ...s, items: [...items, { kind: "user", id: e.id, text: e.text }] };
      return { ...s, items: patch(items, (i) => i.kind === "assistant" && i.id === e.id, (i) => ({ ...i, text: e.text, streaming: false })) };
    }

    case "reasoning.started":
      return { ...s, items: [...items, { kind: "reasoning", id: e.id, chars: 0, done: false }] };
    case "reasoning.delta":
      return { ...s, items: patch(items, (i) => i.kind === "reasoning" && i.id === e.id, (i) => ({ ...i, chars: (i as any).chars + e.text.length })) };
    case "reasoning.completed":
      return { ...s, items: patch(items, (i) => i.kind === "reasoning" && i.id === e.id, (i) => ({ ...i, done: true })) };

    case "tool.started":
      return { ...s, items: [...items, { kind: "tool", callId: e.callId, name: e.name, output: "", running: true }] };
    case "tool.ended":
      return { ...s, items: patchTool(items, e.callId, (t) => ({ ...t, args: e.args })) };
    case "command.output":
      return { ...s, items: patchTool(items, e.callId, (t) => ({ ...t, output: cap(t.output + e.chunk) })) };
    case "tool.result":
      return {
        ...s,
        items: patchTool(items, e.callId, (t) => ({
          ...t,
          running: false,
          ok: e.ok,
          result: typeof e.result === "string" ? e.result : JSON.stringify(e.result),
        })),
      };

    case "permission.requested":
      return { ...s, pending: { requestId: e.requestId, tool: e.tool, radius: e.blastRadius } };
    case "permission.resolved":
      return { ...s, pending: undefined };

    case "turn.completed":
      return e.usage
        ? { ...s, usage: { input: s.usage.input + e.usage.input, output: s.usage.output + e.usage.output } }
        : s;

    case "agent.status":
      return { ...s, status: e.state };

    case "context.compacted":
      return { ...s, items: [...items, { kind: "compaction", dropped: e.droppedSeqs.length, summary: e.summary }] };

    case "error":
      return { ...s, items: [...items, { kind: "error", text: e.message }] };

    default:
      return s;
  }
}

function cap(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? s.slice(-MAX_TOOL_OUTPUT) : s;
}

function patch(items: ViewItem[], match: (i: ViewItem) => boolean, fn: (i: ViewItem) => ViewItem): ViewItem[] {
  const idx = items.findLastIndex(match);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = fn(items[idx]!);
  return next;
}

function patchTool(items: ViewItem[], callId: string, fn: (t: Extract<ViewItem, { kind: "tool" }>) => ViewItem): ViewItem[] {
  return patch(items, (i) => i.kind === "tool" && i.callId === callId, (i) => fn(i as Extract<ViewItem, { kind: "tool" }>));
}
