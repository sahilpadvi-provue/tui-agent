/**
 * The event vocabulary. This is the contract every client consumes.
 *
 * Shape decisions taken deliberately (see foundation research, section 7):
 *  - permission is a correlated request/response pair, not two loose events
 *  - tool calls stream as start -> args -> end -> result, because arguments
 *    stream separately from results
 *  - reasoning is its own family, never message deltas: it carries provider
 *    state that must be replayed verbatim
 *  - a snapshot event exists from day one, emitted by nobody in phase 1,
 *    so a late-joining client can resync without a vocabulary change
 */

export const PROTOCOL_VERSION = 1;

/** A2A-style task states. `input_required` covers permission prompts. */
export type RunState =
  | "submitted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export type Role = "user" | "assistant" | "system" | "tool";

/** Stored verbatim as the provider returned it. Never normalised. */
export type ReasoningPayload = {
  /** Opaque provider-native blob, replayed byte-identical on the next turn. */
  readonly raw: unknown;
  /** Human-readable text, when the provider exposes any. Display only. */
  readonly text?: string;
};

export type TokenUsage = {
  readonly input: number;
  readonly output: number;
  /** Provider-specific extras survive here rather than being flattened away. */
  readonly extra?: Record<string, number>;
};

type Base = {
  /** Monotonic per session. Ordering and replay depend on it. */
  readonly seq: number;
  readonly at: string;
  readonly sessionId: string;
};

export type AgentEvent = Base &
  (
    | { type: "session.started"; cwd: string; model: string }
    | { type: "session.completed"; state: RunState }
    | { type: "turn.started"; turn: number }
    | { type: "turn.completed"; turn: number; usage?: TokenUsage }
    | { type: "message.started"; id: string; role: Role }
    | { type: "message.delta"; id: string; text: string }
    | { type: "message.completed"; id: string; text: string }
    | { type: "reasoning.started"; id: string }
    | { type: "reasoning.delta"; id: string; text: string }
    | { type: "reasoning.completed"; id: string; payload: ReasoningPayload }
    | { type: "tool.started"; callId: string; name: string }
    | { type: "tool.args"; callId: string; chunk: string }
    | { type: "tool.ended"; callId: string; args: unknown }
    | { type: "tool.result"; callId: string; ok: boolean; result: unknown }
    | { type: "command.started"; callId: string; command: string }
    | { type: "command.output"; callId: string; stream: "stdout" | "stderr"; chunk: string }
    | { type: "command.completed"; callId: string; code: number | null; killed: boolean }
    | { type: "file.changed"; path: string; change: "created" | "modified" | "deleted" }
    | { type: "diff.updated"; path: string; patch: string }
    | {
        type: "permission.requested";
        requestId: string;
        callId: string;
        tool: string;
        /** What this will touch, shown before the prompt. */
        blastRadius: BlastRadius;
      }
    | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
    | { type: "context.compacted"; droppedSeqs: number[]; summary: string; reason: string }
    | { type: "context.restored"; restoredSeqs: number[] }
    | { type: "agent.status"; state: RunState; detail?: string }
    | { type: "error"; message: string; fatal: boolean }
    /** Defined, never emitted in phase 1. Present so adding a second client
     *  later does not change event identity. */
    | { type: "state.snapshot"; snapshot: unknown }
  );

export type EventType = AgentEvent["type"];

/** Omit that distributes over the union instead of collapsing it. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What a producer passes to the bus: the bus assigns `seq` and `at`. */
export type EmitInput = DistributiveOmit<AgentEvent, "seq" | "at"> & {
  at?: string;
};

export type BlastRadius = {
  /** Paths the action may write to, as resolved absolute paths. */
  readonly writes: string[];
  /** True when the action can reach the network. */
  readonly network: boolean;
  /** Present for shell commands. */
  readonly command?: string;
};

export type PermissionDecision =
  | { kind: "allow"; scope: "once" | "session" }
  | { kind: "deny"; reason: string };

/** The first line of every log file. Versioned so the format can move. */
export type SessionMeta = {
  readonly kind: "session_meta";
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly model: string;
};
