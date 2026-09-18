import type { ModelChunk, ModelClient, ModelFacts } from "./client.ts";
import type { ConvoMessage } from "../core/projection.ts";

type WireToolCall = {
  id?: string;
  function?: { name?: string; arguments?: unknown; index?: number };
};

type OllamaMessage = {
  role: string;
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: WireToolCall[];
};

/**
 * Accumulates tool calls by index so a call split across chunks is assembled
 * rather than emitted in pieces.
 */
class ToolCallAccumulator {
  #byIndex = new Map<number, { id?: string; name: string; args: unknown }>();

  add(calls: WireToolCall[]): void {
    for (const [position, call] of calls.entries()) {
      const index = call.function?.index ?? position;
      const existing = this.#byIndex.get(index) ?? { name: "", args: undefined };
      this.#byIndex.set(index, {
        ...(call.id ?? existing.id ? { id: call.id ?? existing.id } : {}),
        name: call.function?.name ?? existing.name,
        args: call.function?.arguments ?? existing.args,
      });
    }
  }

  drain(): { id: string; name: string; args: unknown }[] {
    const out = [...this.#byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id ?? `call_${Date.now()}_${index}`,
        name: c.name,
        args: parseArgs(c.args),
      }));
    this.#byIndex.clear();
    return out;
  }
}

/** Ollama sends an object; a JSON string is accepted for provider parity. */
function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Ollama stands in for the gateway during phase 1.
 *
 * The loop cannot tell the difference: swapping this for the gateway is a
 * constructor change. That is the only property this class is required to have.
 */
export class OllamaClient implements ModelClient {
  readonly name: string;
  readonly facts: ModelFacts;

  constructor(
    model = "qwen3:8b",
    private readonly host = "http://localhost:11434",
    facts?: Partial<ModelFacts>,
  ) {
    this.name = model;
    this.facts = {
      contextWindow:
        // Above Ollama's own default, which truncates silently, and below the
        // point where the KV cache stops fitting in GPU memory. Measured on a
        // 16 GB machine with qwen3:8b: 16k leaves the model 7.8 GB resident and
        // 100% on GPU; 40k takes it to 11 GB and spills 12% of the layers to
        // CPU, which cost roughly 3x the wall time on the eval fixtures.
        //
        // This ceiling is a property of the machine, not of the model. On a
        // box with more unified memory the right number is higher; raise it
        // with CONTEXT_WINDOW and check `ollama ps` still reports 100% GPU.
        facts?.contextWindow ?? Number(process.env.CONTEXT_WINDOW ?? 16_384),
      cacheThreshold: facts?.cacheThreshold ?? null,
      supportsTools: facts?.supportsTools ?? true,
    };
  }

  /**
   * What the backend has. The client never hardcodes a model list -- which
   * models exist, and which this user may use, is the backend's to answer.
   */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.host}/api/tags`);
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n).sort();
  }

  async *stream(
    messages: ConvoMessage[],
    tools: unknown[],
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.name,
        messages: messages.map(toOllama),
        tools: tools.length ? tools : undefined,
        stream: true,
        // Always requested. think:false does not silence reasoning on every
        // model -- it only stops the separation, and the reasoning then
        // arrives inside content with an unbalanced closing tag. Asking for
        // it keeps the two channels apart and lets the client decide.
        think: true,
        options: {
          // Ollama's own default is far smaller than an agentic system prompt
          // plus tool results needs, and it truncates silently. The context
          // manager budgets against this number, so it has to be the number
          // actually in force.
          num_ctx: this.facts.contextWindow,
        },
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`ollama ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const calls = new ToolCallAccumulator();
    let buffer = "";
    let thinking = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        const j = JSON.parse(line) as { message?: OllamaMessage; done?: boolean; prompt_eval_count?: number; eval_count?: number };
        const m = j.message;

        if (m?.thinking) {
          thinking += m.thinking;
          yield { kind: "reasoning", text: m.thinking };
        }
        if (m?.content) yield { kind: "text", text: m.content };

        if (m?.tool_calls?.length) calls.add(m.tool_calls);

        if (j.done) {
          // Emitted only once the stream ends: a call may arrive whole in one
          // chunk or split across several keyed by index, and a partial call
          // handed to the loop is the shape that loses its id and name.
          for (const call of calls.drain()) yield { kind: "tool_call", call };

          yield {
            kind: "done",
            usage: {
              input: j.prompt_eval_count ?? 0,
              output: j.eval_count ?? 0,
            },
            // Stored verbatim. Ollama's reasoning is plain text today, but the
            // shape is opaque-by-contract so a provider with signed blocks
            // needs no change here.
            ...(thinking ? { reasoning: { raw: { thinking }, text: thinking } } : {}),
          };
        }
      }
    }
  }
}

/**
 * What goes on the wire, and what deliberately does not.
 *
 * `thinking` and `tool_call_id` are both accepted by Ollama with a 200 and
 * both are discarded. Measured against 0.34.1 with qwen3:8b by comparing
 * `prompt_eval_count` for the same conversation with and without each: 24
 * tokens either way for a 28-token `thinking` string, and 41 either way for a
 * 60-character `tool_call_id`. Removing `tool_name` does not move it either --
 * this model's template renders tool results positionally.
 *
 * So a turn with two calls to the same tool is already ambiguous to the model
 * and adding the id here would not fix it. A provider that keys results by id
 * needs it, which is the second provider's problem and not this file's.
 */
function toOllama(m: ConvoMessage): OllamaMessage {
  if (m.role === "tool") {
    return { role: "tool", content: m.text, tool_name: m.toolName };
  }
  if (m.toolName && m.toolArgs !== undefined) {
    return {
      role: "assistant",
      content: m.text,
      tool_calls: [{ function: { name: m.toolName, arguments: m.toolArgs } }],
    };
  }
  return { role: m.role, content: m.text };
}
