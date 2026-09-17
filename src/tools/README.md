# tools

The tool registry and the built-in tools. This is a security surface before it is a convenience layer.

## What lives here

- **`registry.ts`** — `ToolDef`, the registry, argument validators.
- **`builtin.ts`** — read, write, replace_lines, edit, list, search, shell.
- **`fuzzy.ts`** — whitespace-tolerant matching for `edit_file`.

## Rules

**Every tool declares `kind`** — `read`, `write` or `execute`. The permission policy reads nothing else to decide whether to prompt, so getting this wrong silently changes the security posture.

**`blastRadius` is computed before the tool runs**, and it is what the user sees before approving. It must be honest: if a command can reach the network, say so.

**`validate` throws `ToolArgumentError` on bad input.** It never coerces silently. The error text goes straight back to the model as its next observation, so write it as an instruction the model can act on, not a complaint.

**Structured tools, not shell pipelines.** Every task pushed into `shell` becomes an unallowlistable string and an approval prompt. A richer typed registry is a permission-model decision before it is an ergonomics one.

## Editing tools

`replace_lines` is the primary edit path. `read_file` returns numbered lines (`12| const x = 1`), so editing requires counting rather than transcription.

This exists because small models cannot transcribe exactly: qwen3:8b read a file containing `split(",")` and edited with `split(',')`, twice, after being shown the file. `edit_file` remains for exact matches, with whitespace-tolerant fallback and errors that include the file content.

**Reads are enforced before edits.** Editing an unread file fails. Models invent the text they claim to be replacing, and the system prompt asking them not to is insufficient.

## Gotchas

- All tool output is capped (`MAX_OUTPUT`). A 10 MB test log must never reach the model or the screen.
- `normalisePath` exists because `./src/x.ts` and `src/x.ts` are the same file to a model but different strings to a `Set`.
