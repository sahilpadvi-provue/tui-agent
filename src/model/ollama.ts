import type { ModelChunk, ModelClient, ModelFacts } from "./client.ts";
import type { ConvoMessage } from "../core/projection.ts";

type OllamaMessage = {
  role: string;
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
};

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
        facts?.contextWindow ?? Number(process.env.CONTEXT_WINDOW ?? 40_960),
      cacheThreshold: facts?.cacheThreshold ?? null,
      supportsTools: facts?.supportsTools ?? true,
    };
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
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`ollama ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let thinking = "";
    let callSeq = 0;

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

        for (const tc of m?.tool_calls ?? []) {
          yield {
            kind: "tool_call",
            call: {
              id: `call_${Date.now()}_${callSeq++}`,
              name: tc.function.name,
              args: tc.function.arguments,
            },
          };
        }

        if (j.done) {
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
