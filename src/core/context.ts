import type { ConvoMessage } from "./projection.ts";
import type { ModelFacts } from "../model/client.ts";

/**
 * Context budgeting and compaction.
 *
 * The design goal is the one the incumbents miss: compaction must be
 * inspectable and reversible. Both fall out of the log being the source of
 * truth -- nothing is deleted, so a compaction is a projection decision that
 * names exactly which events it hid and can be undone by naming them again.
 *
 * The summary is built structurally from the dropped events rather than by
 * asking a model. That is deliberate: a model summary is a lossy paraphrase
 * that cannot be audited, and it costs a call at the worst possible moment.
 * A structural summary says precisely what was dropped.
 */

/** Chars-per-token heuristic. Deliberately crude and deliberately visible. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: ConvoMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length;
    if (m.toolArgs) chars += JSON.stringify(m.toolArgs).length;
    // Reasoning is deliberately not counted: `toOllama` does not send it, so
    // charging it budgets for bytes that never leave. It made compaction fire
    // early, on a model that emits more reasoning than answer. Restore this
    // the day a provider replays it -- see `ReasoningPayload`.
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export type CompactionPlan = {
  readonly dropSeqs: number[];
  readonly summary: string;
  readonly reason: string;
  readonly before: number;
  readonly after: number;
};

export type BudgetOptions = {
  /** Fraction of the window at which compaction fires. */
  readonly triggerAt?: number;
  /** Messages at the tail that are never dropped. */
  readonly keepRecent?: number;
  /** Reserved for the model's reply. */
  readonly reserveOutput?: number;
};

/**
 * Returns a plan, or null when nothing needs dropping.
 *
 * Never drops the first user message: it is the task, and losing it is the
 * single most-complained-about compaction failure.
 */
export function planCompaction(
  messages: ConvoMessage[],
  facts: ModelFacts,
  opts: BudgetOptions = {},
): CompactionPlan | null {
  const triggerAt = opts.triggerAt ?? 0.75;
  const keepRecent = opts.keepRecent ?? 6;
  const reserve = opts.reserveOutput ?? 2048;

  const budget = Math.floor((facts.contextWindow - reserve) * triggerAt);
  const before = estimateTokens(messages);
  if (before <= budget) return null;

  const firstUser = messages.findIndex((m) => m.role === "user");
  const head = firstUser === -1 ? 0 : firstUser + 1;
  const tailStart = Math.max(head, messages.length - keepRecent);
  const candidates = messages.slice(head, tailStart);
  if (candidates.length === 0) return null;

  // Drop oldest-first until under budget.
  const dropped: ConvoMessage[] = [];
  let running = before;
  for (const m of candidates) {
    if (running <= budget) break;
    dropped.push(m);
    running -= estimateTokens([m]);
  }
  if (dropped.length === 0) return null;

  return {
    dropSeqs: dropped.map((m) => m.seq),
    summary: summarise(dropped),
    reason: `context ${before} tokens over ${budget} budget (window ${facts.contextWindow})`,
    before,
    after: running,
  };
}

/** A factual account of what was hidden. No paraphrase, nothing invented. */
function summarise(dropped: ConvoMessage[]): string {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  let assistantTurns = 0;

  for (const m of dropped) {
    const a = m.toolArgs as Record<string, unknown> | undefined;
    switch (m.toolName) {
      case "read_file":
        if (typeof a?.path === "string") filesRead.add(a.path);
        break;
      case "write_file":
      case "edit_file":
        if (typeof a?.path === "string") filesWritten.add(a.path);
        break;
      case "shell":
        if (typeof a?.command === "string") commands.push(a.command);
        break;
      default:
        if (m.role === "assistant" && m.text) assistantTurns++;
    }
  }

  const parts: string[] = [];
  if (filesRead.size) parts.push(`read ${[...filesRead].join(", ")}`);
  if (filesWritten.size) parts.push(`edited ${[...filesWritten].join(", ")}`);
  if (commands.length) parts.push(`ran ${commands.map((c) => `\`${c}\``).join(", ")}`);
  if (assistantTurns) parts.push(`${assistantTurns} assistant message(s)`);
  return parts.length ? parts.join("; ") : `${dropped.length} earlier events`;
}
