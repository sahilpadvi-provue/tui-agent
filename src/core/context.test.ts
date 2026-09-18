/**
 * The budget has to measure the request, not the log.
 *
 * These two drifted apart once already: reasoning was counted and never sent,
 * so compaction fired early on a model that emits more reasoning than answer.
 * The estimate is a heuristic and is allowed to be crude; what it is not
 * allowed to be is a different shape from `toOllama`.
 */
import { test, expect, describe } from "bun:test";
import { estimateTokens } from "./context.ts";
import type { ConvoMessage } from "./projection.ts";

const msg = (over: Partial<ConvoMessage> = {}): ConvoMessage =>
  ({ seq: 1, role: "assistant", text: "hello", ...over }) as ConvoMessage;

describe("estimateTokens", () => {
  test("counts the text that is sent", () => {
    expect(estimateTokens([msg({ text: "a".repeat(400) })])).toBe(100);
  });

  test("counts tool arguments, which are sent", () => {
    const bare = estimateTokens([msg({ text: "" })]);
    const withArgs = estimateTokens([msg({ text: "", toolArgs: { path: "a".repeat(100) } })]);
    expect(withArgs).toBeGreaterThan(bare);
  });

  test("does not count reasoning, which is not sent", () => {
    const bare = estimateTokens([msg()]);
    const reasoned = estimateTokens([
      msg({ reasoning: { raw: {}, text: "x".repeat(4000) } }),
    ]);
    expect(reasoned).toBe(bare);
  });
});
