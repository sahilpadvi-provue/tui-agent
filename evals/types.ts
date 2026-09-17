/**
 * The contract between the harness and a fixture.
 *
 * A fixture is a tiny repository, a task, and a verifier. The verifier decides
 * pass or fail from the repository's final state and the recorded events,
 * never from a human reading the output -- otherwise the suite measures our
 * patience rather than the agent.
 */

import type { AgentEvent, RunState } from "../src/core/events.ts";

export type Transcript = {
  readonly events: AgentEvent[];
  /** Assistant text across all turns, concatenated. */
  readonly finalText: string;
  readonly turns: number;
  readonly toolCalls: Record<string, number>;
  readonly state: RunState;
};

export type VerifyContext = {
  /** Absolute path to the copy of the repository the agent worked in. */
  readonly repo: string;
  readonly transcript: Transcript;
  run(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /** File contents as they stand now. Throws if the agent deleted it. */
  read(relPath: string): Promise<string>;
};

export type VerifyResult = { ok: boolean; reason: string };
export type Verifier = (ctx: VerifyContext) => Promise<VerifyResult>;

export type FixtureMeta = {
  /** Directory name under evals/fixtures. */
  readonly name: string;
  /**
   * "capability" is an ordinary task. "trap" targets one failure mode we have
   * actually seen, so a regression announces itself instead of hiding behind
   * a passing average.
   */
  readonly kind: "capability" | "trap";
  /** Part of the fast subset used while iterating. */
  readonly fast: boolean;
  /** What this fixture tests, in one line. */
  readonly intent: string;
};

export type Fixture = {
  readonly meta: FixtureMeta;
  readonly task: string;
  readonly verify: Verifier;
};
