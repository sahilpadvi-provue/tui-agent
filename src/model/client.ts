import type { ReasoningPayload, TokenUsage } from "../core/events.ts";
import type { ConvoMessage } from "../core/projection.ts";

export type ModelToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
};

export type ModelChunk =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call: ModelToolCall }
  | { kind: "done"; usage?: TokenUsage; reasoning?: ReasoningPayload };

/**
 * What the loop needs from a model, and nothing more.
 *
 * Deliberately not shaped like any vendor's wire format: a vendor-shaped
 * interface caps us at that vendor's feature set, which is how provider
 * abstractions silently drop caching and reasoning state.
 */
export interface ModelClient {
  readonly name: string;
  /** Static facts the context manager needs to decide what to send. */
  readonly facts: ModelFacts;
  stream(
    messages: ConvoMessage[],
    tools: unknown[],
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk>;
}

export type ModelFacts = {
  readonly contextWindow: number;
  /** null when the backend does not cache. */
  readonly cacheThreshold: number | null;
  readonly supportsTools: boolean;
};
