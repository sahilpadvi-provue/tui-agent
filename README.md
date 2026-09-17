# tui-agent — phase 1

A terminal coding agent. Local execution, local models via Ollama, one client.

Phase 1 of the plan in `Phase 1 Execution Plan`. The architecture it implements
is in `Agentic Coding Platform: Foundation Research`.

## Run it

```sh
ollama serve &                 # if not already running
ollama pull qwen3:8b

bun install
bun run tui                                  # the terminal client
bun run agent "fix the failing test" --yes   # headless, no UI
bun run agent --resume <id> "now add a test" # continue a session
bun run replay .sessions/<id>.jsonl          # reconstruct a session from its log

bun run sessions list                        # sessions in this repo
bun run sessions context <id>                # what compaction hid, and how to undo it
bun run sessions restore <id> 265,266        # put hidden events back in context
bun run sessions checkpoints                 # git snapshots taken before edits
```

Flags: `--no-sandbox` disables OS containment, `CONTEXT_WINDOW=3000` forces
early compaction for testing.

`MODEL=<name>` overrides the Ollama model.

## Commands

Typed into the composer with a leading `/`. They are the user acting on the
session, so they run immediately even mid-turn, are recorded in the log for the
audit trail, and are skipped by the conversation projection — `/help` is not
something the agent said.

| | |
| --- | --- |
| `/help` | list the commands |
| `/context` | what compaction hid, with the line to put it back |
| `/restore <seqs>` | put those events back into context |
| `/model [name]` | show what the backend offers, or switch |
| `/sessions` | sessions recorded in this workspace |
| `/resume <id>` | how to continue an earlier one |
| `/checkpoints` | git snapshots taken before edits |
| `/clear` | start a fresh conversation, keeping the log |

Every one is implemented against something local today. `/model` is the one
that becomes a gateway call — it asks `availableModels()`, which is injected in
`src/cli/tui.tsx` rather than imported, so the swap is a change to that file
and to nothing else.

## Building

```sh
bun run build      # dist/tui and dist/agent, ~60 MB each
```

Both are standalone: verified running a real task with neither Bun nor
`node_modules` present. Ink pulls in `react-devtools-core` lazily, which the
compiler cannot resolve, so it is marked external — it is a development-only
path and is never reached in a built binary.

## Layout

```
src/
  core/      events.ts   the event vocabulary — the contract every client consumes
             bus.ts      in-process typed pub/sub
             log.ts      append-only JSONL, the source of truth
             projection.ts  rebuilds a conversation from events
             loop.ts     the agent loop — emits events, renders nothing
  exec/      executor.ts the execution boundary (async, stream-shaped)
             local.ts    local implementation, workspace-bounded
  tools/     registry.ts typed tool schemas
             builtin.ts  read / write / edit / list / search / shell
  model/     client.ts   what the loop needs from a model
             ollama.ts   Ollama adapter (stands in for the gateway)
  permissions/policy.ts  tiered policy + category deny rules
  ui/        primitives.tsx  the ONLY module importing Ink
             model.ts        view state as a fold over events
             App.tsx         the screen
  cli/       headless.ts     stage 1 driver (no UI)
             tui.tsx         stage 2 terminal client
```

## The two rules that matter

**The UI never calls the runtime.** It subscribes to the bus and receives
`onSubmit` / `onCancel` / `onPermission` callbacks. It holds no reference to
the loop, the executor or the model. This is what makes a second client cheap
later, and `bun run agent` is the standing proof it still holds: the same
runtime completes tasks with no UI mounted at all.

**Only `ui/primitives.tsx` imports Ink.** Swapping renderers is a rewrite of
that one file.

## Gates

| Gate | Command | Status |
| --- | --- | --- |
| Log replays into a conversation | `bun run replay fixtures/handwritten.jsonl` | passing |
| Compaction is reversible | replay with a `context.restored` event | passing |
| Agent completes a task with no UI | `bun run agent "..." --yes` | passing |
| Workspace boundary holds | `bun run scripts/boundary.ts` | passing |
| Render cost on a long transcript | `bun run scripts/bench.tsx` | passing |
| Ctrl-C quits when idle | `bun run scripts/quit-check.tsx` | passing |
| UI changes nothing the runtime records | `bun run scripts/log-equivalence.tsx` | passing |
| Typing stays live during a turn | `bun run scripts/queue-check.tsx` | passing |
| Esc kills the process tree, keeps partial output | `bun run scripts/cancel-check.ts` | passing |
| A session survives the process that made it | `bun run scripts/resume-check.ts` | passing |
| Commands run locally and stay out of the model's context | `bun run scripts/commands-check.tsx` | passing |
| Resizing does not reprint, and the live region stays bounded | `bun run scripts/resize-check.tsx` | passing |
| No live line reaches the terminal width | `bun run scripts/reflow-check.tsx` | passing |
| Sandbox blocks writes and egress | `bun run scripts/sandbox-check.ts` | passing |
| Checkpoint restores a damaged file | `bun run scripts/checkpoint-check.ts` | passing |

## Editing with small models

`edit_file` needs the model to reproduce existing text byte-for-byte. qwen3:8b
cannot: it read a file containing `split(",")` and edited with `split(',')`,
twice, after being shown the file. Two guardrails followed, and both are worth
keeping for any model:

- **`replace_lines` is the primary edit tool.** `read_file` returns numbered
  lines, so editing needs counting rather than transcription.
- **Reads are enforced before edits.** Editing an unread file fails with an
  instruction to read it first, because models invent the text they claim to
  be replacing.

`edit_file` remains, with whitespace-tolerant matching and errors that include
the actual file content so the model can correct itself.

## Not in phase 1

No wire protocol, no container execution, no web or IDE client, no subagents,
no MCP. See the plan's exclusion table for why each is deliberate.
