# cli

Entry points. This is the only layer allowed to know about every other one.

## What lives here

- **`headless.ts`** — the agent with no UI. Wires the runtime, prints from a bus subscription.
- **`tui.tsx`** — the terminal client. Wires the same runtime, mounts `ui/`.
- **`sessions.ts`** — list sessions, inspect what compaction hid, restore it, list checkpoints.

## Rules

**Wiring lives here, nowhere else.** `core/` does not construct an executor; `ui/` does not construct a loop. Both are assembled here and handed their dependencies.

**`headless.ts` is not a debug tool.** It is the standing proof that the runtime is independent of the UI, and it is the first gate in the phase plan. If it stops being able to complete a real task, the architecture has regressed regardless of what the TUI does.

Both entry points must produce the **same event log** for the same task. That equivalence is the boundary, expressed as a testable claim.

## Gotchas

- `tui.tsx` needs a real TTY. It will not run piped, in CI, or inside another agent's shell — `useInput` throws without raw mode.
- `headless.ts` prints from a bus subscription like any other client. It decides nothing; do not let approval logic drift into it beyond the `--yes` flag.
- Session resume rehydrates the bus sequence counter from the log's last event. Constructing a fresh `EventBus` on resume would restart `seq` at 0 and corrupt ordering.
