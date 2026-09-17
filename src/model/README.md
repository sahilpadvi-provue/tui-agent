# model

What the agent loop needs from a model, and the adapters that provide it.

## What lives here

- **`client.ts`** — the `ModelClient` interface, `ModelChunk`, `ModelFacts`.
- **`ollama.ts`** — the Ollama adapter. Stands in for the gateway during phase 1.

## Rules

**The interface is not shaped like any vendor's wire format.** A vendor-shaped interface caps the system at that vendor's feature set, which is how provider abstractions silently drop caching and reasoning continuity. Shape it around what the loop needs.

**Adapters, not a normalising shim.** A layer that flattens providers into one shape invents its own bugs at the seams — LiteLLM's re-chunker drops tool-call ids when a provider sends a complete call in one delta, and its Messages bridge loses reasoning-cache continuity entirely.

**Reasoning is opaque.** `ReasoningPayload.raw` is stored and replayed byte-identical. `text` is display only. Never reconstruct `raw` from `text`.

## When the gateway replaces Ollama

Swapping is a constructor change in `cli/`. The loop cannot tell the difference, and that is the only property this layer is required to have. What stays client-side regardless:

- the per-model facts table (`contextWindow`, `cacheThreshold`), because the client decides what to send when the window fills
- verbatim reasoning storage, because the client holds the conversation
- usage numbers, because the client displays cost

## Gotchas

- Ollama streams `thinking` separately from `content`. Keep them separate all the way to the event stream; reasoning that arrives as `message.delta` cannot be replayed correctly.
- `CONTEXT_WINDOW` overrides the window for testing compaction. It is not a real model fact.
