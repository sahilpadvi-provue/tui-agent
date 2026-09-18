# src

The layers, innermost first. Each depends only on the ones above it in this list.

| Folder | Owns | Depends on |
| --- | --- | --- |
| `core/` | Events, bus, log, projection, agent loop, context budgeting | nothing outside itself |
| `exec/` | The execution boundary, local implementation, sandbox, checkpoints | `core/events` for types only |
| `tools/` | Tool registry and the built-in tools | `exec/` |
| `model/` | What the loop needs from a model, and the Ollama adapter | `core/projection` for message shape |
| `permissions/` | Tiered policy and category deny rules | `core/events`, `tools/` |
| `theme/` | What a colour means, with no idea what a terminal is | nothing |
| `ui/` | The terminal client | `core/` (events only), `theme/`, `permissions/` for display |
| `commands/` | Slash commands the user runs, as opposed to tools the model calls | `core/`, `exec/` |
| `cli/` | Entry points that wire the above together | everything |

The dependency direction is the design. `core/` cannot import `ui/`; if it ever needs to, the boundary has failed.

## The one rule

`ui/` subscribes to the event bus and calls nothing in `core/`. Wiring happens in `cli/`, which hands the UI callbacks. `bun run agent` runs the whole system with `ui/` unloaded, and that is the standing proof the rule holds.
