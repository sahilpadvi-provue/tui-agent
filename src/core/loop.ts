import type { EventBus } from "./bus.ts";
import type { AgentEvent, PermissionDecision, RunState } from "./events.ts";
import type { ModelClient } from "../model/client.ts";
import type { ToolRegistry, ToolContext } from "../tools/registry.ts";
import { ToolArgumentError } from "../tools/registry.ts";
import { PermissionPolicy } from "../permissions/policy.ts";
import { project, type ConvoMessage } from "./projection.ts";
import { planCompaction, estimateTokens, type BudgetOptions } from "./context.ts";
import { checkpoint, isGitRepo } from "../exec/checkpoint.ts";
import { WorkspaceViolation } from "../exec/executor.ts";

export type PermissionAsker = (
  req: Extract<AgentEvent, { type: "permission.requested" }>,
) => Promise<PermissionDecision>;

export type LoopOptions = {
  readonly sessionId: string;
  readonly bus: EventBus;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly policy: PermissionPolicy;
  readonly toolContext: ToolContext;
  /** How the runtime asks for approval. It never prompts anyone itself. */
  readonly ask: PermissionAsker;
  /** Prior events, when resuming. */
  readonly history?: AgentEvent[];
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  readonly budget?: BudgetOptions;
  /**
   * Consecutive denials tolerated before the run stops. Without it, a model
   * that keeps proposing an action the operator will not allow pins them in
   * an approval loop.
   */
  readonly maxConsecutiveDenials?: number;
  /** Snapshot the working tree before the first write of a session. */
  readonly checkpoints?: boolean;
};

const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
const MAX_CONSECUTIVE_DENIALS = 3;
/**
 * A turn that produces neither a tool call nor a word is a stall, not an
 * answer. Small models reason themselves out of their output budget and
 * return nothing; one retry is worth taking because the next sample often
 * differs, but a second identical turn means it is stuck.
 */
const MAX_STALLED_TURNS = 2;

/**
 * Said to the model when it tries to finish having changed files without
 * running anything. The system prompt already asks for this; asking is not
 * enough, so the loop declines the ending and says why.
 */
const VERIFY_NUDGE =
  "You have modified files but have not run anything since. Run the project's " +
  "tests or the relevant command, read the result, and fix what it reports. " +
  "Do not summarise until you have seen it pass.";

/**
 * The agent loop.
 *
 * Stateless with respect to any UI: it takes a conversation and a tool
 * registry, emits events, and waits on a promise for permission. It has no
 * reference to a renderer and cannot print. That is what lets the same loop
 * drive a terminal, a web client, or a test harness -- and the stage 1 gate
 * is exactly the proof that this holds.
 */
export class AgentLoop {
  #history: AgentEvent[];
  #abort = new AbortController();
  #consecutiveDenials = 0;

  constructor(private readonly o: LoopOptions) {
    this.#history = [...(o.history ?? [])];
    o.bus.on((e) => this.#history.push(e));
  }

  cancel(): void {
    this.#abort.abort();
  }

  async run(userText: string): Promise<RunState> {
    const { bus, model, tools, policy } = this.o;
    const maxTurns = this.o.maxTurns ?? 20;

    const mid = `m_${Date.now()}`;
    bus.emit({ sessionId: this.#sid(), type: "message.started", id: mid, role: "user" });
    bus.emit({ sessionId: this.#sid(), type: "message.completed", id: mid, text: userText });

    let consecutiveFailures = 0;
    let stalls = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (this.#abort.signal.aborted) return this.#finish("cancelled");

      bus.emit({ sessionId: this.#sid(), type: "turn.started", turn });
      bus.emit({ sessionId: this.#sid(), type: "agent.status", state: "working" });

      this.#compactIfNeeded();
      const messages = this.#messages();
      let text = "";
      let reasoningId: string | undefined;
      const pendingCalls: { id: string; name: string; args: unknown }[] = [];
      const assistantId = `a_${Date.now()}_${turn}`;
      let started = false;

      try {
        for await (const ch of model.stream(messages, tools.schemas(), this.#abort.signal)) {
          switch (ch.kind) {
            case "reasoning":
              if (!reasoningId) {
                reasoningId = `r_${Date.now()}_${turn}`;
                bus.emit({ sessionId: this.#sid(), type: "reasoning.started", id: reasoningId });
              }
              bus.emit({ sessionId: this.#sid(), type: "reasoning.delta", id: reasoningId, text: ch.text });
              break;
            case "text":
              if (!started) {
                started = true;
                bus.emit({ sessionId: this.#sid(), type: "message.started", id: assistantId, role: "assistant" });
              }
              text += ch.text;
              bus.emit({ sessionId: this.#sid(), type: "message.delta", id: assistantId, text: ch.text });
              break;
            case "tool_call":
              pendingCalls.push(ch.call);
              break;
            case "done":
              if (reasoningId && ch.reasoning) {
                bus.emit({
                  sessionId: this.#sid(),
                  type: "reasoning.completed",
                  id: reasoningId,
                  payload: ch.reasoning,
                });
              }
              if (started) {
                bus.emit({ sessionId: this.#sid(), type: "message.completed", id: assistantId, text });
              }
              bus.emit({ sessionId: this.#sid(), type: "turn.completed", turn, usage: ch.usage });
              break;
          }
        }
      } catch (err) {
        if (this.#abort.signal.aborted) return this.#finish("cancelled");
        bus.emit({
          sessionId: this.#sid(),
          type: "error",
          message: `model error: ${(err as Error).message}`,
          fatal: true,
        });
        return this.#finish("failed");
      }

      if (pendingCalls.length === 0) {
        // Said nothing and did nothing. Reporting this as completion is how a
        // failed run comes to look like a successful one.
        if (!started || text.trim() === "") {
          stalls++;
          const reasoned = reasoningId ? " after reasoning without concluding" : "";
          bus.emit({
            sessionId: this.#sid(),
            type: "error",
            message: `model produced no output and no tool call${reasoned}`,
            fatal: stalls >= MAX_STALLED_TURNS,
          });
          if (stalls >= MAX_STALLED_TURNS) return this.#finish("failed");
          continue;
        }
        // Said something, asked for nothing: the model is done talking --
        // unless it is signing off on work it never checked.
        if (this.#unverified.size > 0 && !this.#nudged) {
          this.#nudged = true;
          bus.emit({
            sessionId: this.#sid(),
            type: "agent.status",
            state: "working",
            detail: `finishing without verifying ${this.#unverified.size} changed file(s)`,
          });
          continue;
        }
        return this.#finish("completed");
      }
      stalls = 0;

      for (const call of pendingCalls) {
        const ok = await this.#runTool(call);
        consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          bus.emit({
            sessionId: this.#sid(),
            type: "error",
            message: `${consecutiveFailures} consecutive tool failures; stopping`,
            fatal: true,
          });
          return this.#finish("failed");
        }
      }
    }

    bus.emit({ sessionId: this.#sid(), type: "error", message: `hit ${maxTurns}-turn limit`, fatal: false });
    return this.#finish("failed");
  }

  /** Returns false when the call failed, so the caller can count failures. */
  async #runTool(call: { id: string; name: string; args: unknown }): Promise<boolean> {
    const { bus, tools, policy } = this.o;
    bus.emit({ sessionId: this.#sid(), type: "tool.started", callId: call.id, name: call.name });

    const tool = tools.get(call.name);
    if (!tool) {
      bus.emit({ sessionId: this.#sid(), type: "tool.ended", callId: call.id, args: call.args });
      return this.#toolError(call.id, `no tool named "${call.name}". Available: ${tools.list().map((t) => t.name).join(", ")}`);
    }

    let args: unknown;
    try {
      args = tool.validate(call.args);
    } catch (err) {
      bus.emit({ sessionId: this.#sid(), type: "tool.ended", callId: call.id, args: call.args });
      return this.#toolError(call.id, (err as Error).message);
    }

    bus.emit({ sessionId: this.#sid(), type: "tool.ended", callId: call.id, args });

    const radius = tool.blastRadius(args as never, this.o.toolContext);
    const outcome = policy.evaluate(tool, radius);

    if (outcome.kind === "deny") {
      return this.#toolError(call.id, `denied: ${outcome.reason}`);
    }
    if (outcome.kind === "ask") {
      const requestId = `p_${call.id}`;
      const req = bus.emit({
        sessionId: this.#sid(),
        type: "permission.requested",
        requestId,
        callId: call.id,
        tool: tool.name,
        blastRadius: radius,
      }) as Extract<AgentEvent, { type: "permission.requested" }>;

      bus.emit({ sessionId: this.#sid(), type: "agent.status", state: "input_required" });
      const decision = await this.o.ask(req);
      bus.emit({ sessionId: this.#sid(), type: "permission.resolved", requestId, decision });
      policy.record(tool.name, decision);

      if (decision.kind === "deny") {
        this.#consecutiveDenials++;
        const limit = this.o.maxConsecutiveDenials ?? MAX_CONSECUTIVE_DENIALS;
        if (this.#consecutiveDenials >= limit) {
          bus.emit({
            sessionId: this.#sid(),
            type: "error",
            message: `${this.#consecutiveDenials} consecutive denials; stopping rather than asking again`,
            fatal: true,
          });
          this.#abort.abort();
        }
        return this.#toolError(call.id, `user denied: ${decision.reason}`);
      }
      this.#consecutiveDenials = 0;
    }

    if (tool.kind !== "read") {
      this.#maybeCheckpoint(`before ${tool.name}`);
    }

    if (radius.command) {
      bus.emit({ sessionId: this.#sid(), type: "command.started", callId: call.id, command: radius.command });
    }

    try {
      const ctx: ToolContext = {
        ...this.o.toolContext,
        readFiles: this.#readFiles,
        opts: { ...this.o.toolContext.opts, signal: this.#abort.signal },
        onOutput: (stream, chunk) =>
          bus.emit({ sessionId: this.#sid(), type: "command.output", callId: call.id, stream, chunk }),
      };
      const result = await tool.run(args as never, ctx);

      if (radius.command) {
        bus.emit({
          sessionId: this.#sid(),
          type: "command.completed",
          callId: call.id,
          code: this.#abort.signal.aborted ? null : 0,
          killed: this.#abort.signal.aborted,
        });
      }
      for (const w of radius.writes) {
        if (tool.kind === "write") {
          this.#unverified.add(w);
          bus.emit({ sessionId: this.#sid(), type: "file.changed", path: w, change: "modified" });
        }
      }
      // Running something is how a change gets checked; what it proves is the
      // model's problem, but until it runs, nothing has been observed.
      if (tool.kind === "execute") this.#unverified.clear();
      bus.emit({ sessionId: this.#sid(), type: "tool.result", callId: call.id, ok: true, result });
      return true;
    } catch (err) {
      // A weak model producing bad arguments is expected, not exceptional:
      // hand the error back so it can correct itself rather than crashing.
      const e = err as Error;
      const message =
        e instanceof WorkspaceViolation || e instanceof ToolArgumentError
          ? e.message
          : `${e.name}: ${e.message}`;
      return this.#toolError(call.id, message);
    }
  }

  #toolError(callId: string, message: string): false {
    this.o.bus.emit({
      sessionId: this.#sid(),
      type: "tool.result",
      callId,
      ok: false,
      result: `ERROR: ${message}`,
    });
    return false;
  }

  /**
   * Compacts before the call that would overflow, not after. Firing mid-task
   * at 80% of the window is the complaint; the events stay in the log either
   * way, so this hides rather than destroys.
   */
  #compactIfNeeded(): void {
    const { messages } = project(this.#history);
    const plan = planCompaction(messages, this.o.model.facts, this.o.budget);
    if (!plan) return;
    this.o.bus.emit({
      sessionId: this.#sid(),
      type: "context.compacted",
      droppedSeqs: plan.dropSeqs,
      summary: plan.summary,
      reason: plan.reason,
    });
  }

  /** Restores previously compacted events into the window. */
  restore(seqs: number[]): void {
    this.o.bus.emit({ sessionId: this.#sid(), type: "context.restored", restoredSeqs: seqs });
  }

  readonly #readFiles = new Set<string>();
  #checkpointed = false;
  /** Files written since the last command ran. Cleared when one does. */
  #unverified = new Set<string>();
  #nudged = false;
  #maybeCheckpoint(label: string): void {
    if (!this.o.checkpoints || this.#checkpointed) return;
    const cwd = this.o.toolContext.opts.cwd;
    if (!isGitRepo(cwd)) return;
    this.#checkpointed = true;
    checkpoint(cwd, label);
  }

  #messages(): ConvoMessage[] {
    const { messages } = project(this.#history);
    const system = [this.o.systemPrompt, this.#nudged && this.#unverified.size > 0 ? VERIFY_NUDGE : ""]
      .filter(Boolean)
      .join("\n\n");
    return system ? [{ seq: -1, role: "system", text: system }, ...messages] : messages;
  }

  #finish(state: RunState): RunState {
    this.o.bus.emit({ sessionId: this.#sid(), type: "agent.status", state });
    return state;
  }

  #sid(): string {
    return this.o.sessionId;
  }
}
