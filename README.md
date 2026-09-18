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
bun run tui --continue                       # reopen the most recent session
bun run tui --resume                         # pick one from a list
bun run tui --resume <id>                    # reopen that one
bun run agent "fix the failing test" --yes   # headless, no UI
bun run agent --resume <id> "now add a test" # continue a session, headless
bun run agent --resume                       # list what there is to resume
bun run replay .sessions/<id>.jsonl          # reconstruct a session from its log

bun run sessions list                        # sessions in this repo
bun run sessions context <id>                # what compaction hid, and how to undo it
bun run sessions restore <id> 265,266        # put hidden events back in context
bun run sessions checkpoints                 # git snapshots taken before edits
```

Flags: `--no-sandbox` disables OS containment, `CONTEXT_WINDOW=3000` forces
early compaction for testing.

`NO_MOTION=1` suppresses decorative animation, on `NO_COLOR`'s rule: present
and non-empty is enough, whatever the value. The elapsed clock keeps counting,
because a number that stops is not calmer.

`MODEL=<name>` overrides the Ollama model.

## The renderer

The terminal UI is drawn by our own cell renderer, in `src/ui/render/`. It
holds a grid the height of everything rendered so far and treats the terminal
as a window onto that grid's last rows. Rows above the window are never
addressed again, so settled output reaches the terminal's own scrollback and
stays searchable and copyable with the keys you already use.

It replaced Ink, which had one defect we could not fix from outside. Ink builds
a frame as a string and erases it by counting newlines, and that count stops
being a row count the moment the terminal re-wraps a line wider than the new
width. Narrowing therefore left a stack of ghost composers down the screen.
That is [ink#907](https://github.com/vadimdemedes/ink/issues/907), closed
upstream as not planned, and it is worth being precise about why: upstream did
fix the larger resize bug, in
[#828](https://github.com/vadimdemedes/ink/pull/828), which ships in the 7.1.1
we were using. That fix is exact only while nothing in the redrawn region
reaches the terminal's width. Our composer draws two full-width rules, so we
were outside its precondition, and the only fixes were to drop the chrome --
tried, and it cost the composer's border and the footer's right edge -- or to
own the cells. A renderer that addresses rows has no erase-by-line-count step
to miscount.

Ink remains a dev dependency, for two jobs. `scripts/render-check.tsx` drives
it as a control arm on the same frames, which makes the difference above a
measurement rather than a claim. And it is the second implementation of the
renderer contract, which is what keeps that contract honest.

What the cutover also bought, measured on the same 500-message transcript:

|  | Ink | cells |
| --- | --- | --- |
| bytes written | 1.49 MB | 0.05 MB |

A heap comparison was recorded here too and has been removed: `bench.tsx` heap
is noise-dominated, and three runs on one tree span 19 to 47 MB. It measured
the garbage collector, not the renderer.

Still a subset. The key parser covers what the app reads and is gated, but it
is not Ink's four hundred lines: a key nobody has asked for yet will not work
until someone adds it.

## Swapping the renderer

The UI is written against `src/ui/primitives.tsx` -- `Stack`, `Label`,
`Settled` and four hooks -- and nothing there knows what a terminal is. The
renderer behind it is a `Backend` (`src/ui/backend.ts`), chosen at `mount` and
read from React context.

The contract is two components, `Settled`, `mount`, four hooks and
`renderToText`, and it is that small because that is all `App` uses: 43
`Label`s, 9 `Stack`s and one `Settled`. A new renderer is one file in
`src/ui/backends/`; `primitives.tsx` and `App.tsx` do not move.

There are two backends because a contract with one implementation behind it is
a guess. `backends/cells.tsx` is the default and ships; `backends/ink.tsx` is
dev-only, and `bun run backend:check` holds both to the same screen on every
run -- for a synthetic tree and for the real `App`. It earned that place
immediately, catching a wrapper bug where a rerender changed the root element's
type, remounted the tree and silently reset every piece of UI state.

Two divergences are recorded rather than smoothed over. `Settled` must be the
tree's first child, because Ink implements it with `Static`, which prepends to
the frame instead of placing it in tree order. And `align="between"` differs by
two columns, because a flex engine subtracts the container's padding from the
free space it distributes while the line model fills to the terminal edge --
the only row of the real `App` the two backends do not match exactly.

The indirection costs about 6% of streaming throughput (2997 against 2806
deltas/sec, three runs each): one extra fiber per element, plus a context read.
Bytes written and frame count are unchanged.

## The composer

Enter sends. `ctrl-j` inserts a line break, and the prompt grows a row at a
time, with the `›` marker on the first row and the rest indented to align
with the text. The arrows move by row while there is a row to move to; on the
first row, up is still history. `?` on an empty prompt lists every binding.

It is `ctrl-j` rather than Shift+Enter because in a terminal without the kitty
keyboard protocol those are the same byte -- Shift+Enter sends `\r`, exactly as
Enter does, and nothing in the application can tell them apart. Codex defaults
to `ctrl-j` for the same reason, Claude Code offers `ctrl-j` and `\` then Enter
in every terminal and treats Shift+Enter as a per-terminal enhancement on top,
and OpenTUI's textarea binds newline to return and linefeed and moves submit to
meta+return. Shift+Enter can be layered on later through the kitty protocol;
`ctrl-j` stays underneath it, because enabling that protocol re-encodes escape,
tab, backspace and every ctrl binding as `CSI u` and a half-answering terminal
must not be able to take `ctrl-c` away.

A multi-line paste is still a single `[Pasted text #1 +13 lines]` chip rather
than rows: one deliberate line break is not a block worth collapsing, and a
pasted stack trace is.

## Sessions

Every session is a log, and resuming one is a read of that log: the transcript
on screen, the context sent to the model, and the sequence numbers all come
back from the same file. There is no session state anywhere else.

`--continue` reopens the most recent session in this workspace. `--resume <id>`
reopens that one. `--resume` with no id opens a picker, and so does `/resume`
inside a running session, where choosing one switches without quitting.

Only sessions recorded in this workspace are offered, because a log describes
files another tree may not have. That comparison resolves symlinks first: a
string comparison refused sessions the workspace had recorded itself, since
macOS reaches `/tmp` and `/var` through links.

A session's log is written on its first event, not at launch, so looking around
and quitting leaves nothing behind.

## Commands

Typing `/` lists them with what each one does, filtered as you type. Typed into the composer with a leading `/`. They are the user acting on the
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
| `/resume [id]` | switch to an earlier session, or pick one from a list |
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
path and is never reached in a built binary. Nothing in `src/` imports the Ink
backend, so neither it nor Ink is in the binary: `dist/tui` carries `tui-box`
and none of `ink-box`, `cli-boxes` or `inkBackend`.

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
  ui/        backend.ts      the renderer contract
             backends/       one file per renderer (cells ships, ink is dev-only)
             primitives.tsx  the surface screens are written against
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

**No screen knows how a frame reaches the terminal.** Screens import
`ui/primitives.tsx`; only a backend in `ui/backends/` imports a renderer.
Swapping renderers is writing one more file there, and `bun run backend:check`
is what proves the boundary held.

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
| Resume works from the terminal client, end to end | `bun run resume:check` | passing |
| Commands run locally and stay out of the model's context | `bun run scripts/commands-check.tsx` | passing |
| Resizing does not reprint, and the live region stays bounded | `bun run scripts/resize-check.tsx` | passing |
| Sandbox blocks writes and egress | `bun run scripts/sandbox-check.ts` | passing |
| Checkpoint restores a damaged file | `bun run scripts/checkpoint-check.ts` | passing |
| Every renderer backend draws the same screen | `bun run backend:check` | passing |
| One shared clock, and none when nothing animates | `bun run clock:check` | passing |

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
