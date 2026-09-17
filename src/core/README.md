# core

The agent runtime. No I/O beyond the log file, no rendering, no knowledge of any client.

## What lives here

- **`events.ts`** — the event vocabulary. The contract every client consumes, and the file to read first.
- **`bus.ts`** — in-process typed pub/sub. Assigns `seq`. The only path out of the runtime.
- **`log.ts`** — append-only JSONL. First line is `session_meta` carrying the protocol version.
- **`projection.ts`** — rebuilds a conversation from events. Applies compaction as a *view*.
- **`loop.ts`** — the agent loop. Emits events, waits on a promise for permission.
- **`context.ts`** — token budgeting and compaction planning.
- **`session.ts`** — session discovery and resume.
- **`prompt.ts`** — the system prompt.

## Rules

**The log is append-only.** Never delete or rewrite an event. Compaction hides events by `seq`; `context.restored` un-hides them. Reversibility is the product differentiator and it depends entirely on this.

**The loop renders nothing and prompts nobody.** It emits `permission.requested` and awaits a promise the caller owns. If you find yourself reaching for `console.log` or a readline here, the boundary is being broken.

**Event identity is expensive to change.** Adding an event type is free. Splitting one event into three breaks every recorded log — if you must, bump `PROTOCOL_VERSION` and handle the old shape on read.

## Gotchas

- `EmitInput` uses a distributive `Omit`. Plain `Omit<AgentEvent, ...>` collapses the union and every event payload becomes an error.
- Reasoning payloads are stored **verbatim** as the provider returned them. A normalised copy cannot be replayed, and some providers reject a conversation whose reasoning blocks changed.
- `estimateTokens` is a chars/4 heuristic. It is deliberately crude and deliberately visible; do not present its output as an exact count.
