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
  | { kind: "compaction"; dropped: number; summary: string }
  /** A command the user ran. Rendered like a tool call, attributed to them. */
  | { kind: "local"; command: string; args: string; ok: boolean; output: string };

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

/** Drops what is on screen without touching the log. Used by /clear. */
export function cleared(s: ViewState): ViewState {
  return { ...initialState, usage: s.usage };
}

const MAX_TOOL_OUTPUT = 4000;



export type ViewAction =
  | AgentEvent
  | { kind: "clear" }
  | { kind: "seed"; events: readonly AgentEvent[] };

export function reduce(s: ViewState, action: ViewAction): ViewState {
  if ("kind" in action && action.kind === "clear") return cleared(s);
  // Switching sessions replaces the screen with a fold over the other log.
  // Folding rather than storing a rendered transcript is what keeps one code
  // path between a live session and a resumed one: if the fold is wrong, it is
  // wrong live too, where it would be noticed.
  if ("kind" in action && action.kind === "seed") {
    return action.events.reduce<ViewState>((acc, e) => reduce(acc, e), initialState);
  }
  const e = action as AgentEvent;
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
    /**
     * Ignored on purpose.
     *
     * Reasoning arrives in thousands of deltas and the line it draws does not
     * change, so reacting to each one meant thousands of redraws of identical
     * characters -- and every redraw is another chance for a terminal whose
     * erase bookkeeping is off to append instead of replace. The shimmer
     * already says the agent is alive, and the exact length arrives with the
     * completion event.
     */
    case "reasoning.delta":
      return s;

    case "reasoning.completed":
      return {
        ...s,
        items: patch(items, (i) => i.kind === "reasoning" && i.id === e.id, (i) => ({
          ...i,
          done: true,
          chars: e.payload.text?.length ?? (i as Extract<ViewItem, { kind: "reasoning" }>).chars,
        })),
      };

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

    case "local.invoked":
      return {
        ...s,
        items: [...items, { kind: "local", command: e.command, args: e.args, ok: e.ok, output: e.output }],
      };

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
