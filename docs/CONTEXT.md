# tui-agent — session context

A handoff brief for picking the project up in a fresh session. The durable
architecture lives in `CLAUDE.md` and the per-directory `README.md` files; this
is the state and the lessons that are not obvious from the code.

## What this is

A terminal-based agentic coding CLI (same category as Claude Code / Codex CLI),
built to run our own models eventually; Ollama stands in today (`qwen3:8b`, via
the `MODEL` env). TypeScript on Bun. Private repo
`github.com/sahilpadvi-provue/tui-agent`, everything pushed. Working dir
`/Users/sahilpadvi/Desktop/TUI`, macOS.

## Phase status (5 phases, from the Foundation Research doc)

- **Phase 0 Foundations** — done.
- **Phase 1 terminal product** — done and shipped.
- **Phase 2 container exec + hardening** — partly started. Done: the
  OpenTUI-vs-Ink benchmark (led to our own renderer), git checkpointing
  present. Not started: container executor, egress allowlist proxy,
  prompt-injection probe, MCP client.
- **Phase 3 web** and **Phase 4 IDE/desktop** — not started.

## The five invariants (in CLAUDE.md; do not break)

1. The UI never calls the runtime. It subscribes to the bus and receives
   `onSubmit` / `onCancel` / `onPermission`. `bun run agent` is the standing
   proof: the same runtime completes tasks with no UI mounted.
2. No screen knows how a frame reaches the terminal. The UI imports
   `Stack` / `Label` / `Settled` / hooks from `src/ui/primitives.tsx`; the
   renderer behind them is a `Backend` (`src/ui/backend.ts`) chosen at `mount`
   and read from context. A renderer is one file in `src/ui/backends/`.
3. The event log is append-only and the source of truth. Compaction hides
   events by seq; `context.restored` un-hides. Reversible, and the product's
   main differentiator.
4. The executor interface stays async and stream-shaped (the container backend
   speaks HTTP in Phase 2).
5. No wire protocol until a second client exists.

## Why the newline key is ctrl-j and not Shift+Enter

Worth recording because the obvious answer is wrong and the research is not
cheap to repeat. In a terminal without the kitty keyboard protocol Shift+Enter
is byte-identical to Enter: both send `\r`, and no application code can tell
them apart. Checked against the three products that solved this:

- **Claude Code** (read out of the 2.1.276 binary and its docs): `ctrl-j` and
  `\` then Enter work in every terminal with no setup. Shift+Enter is an
  enhancement layered on top -- the kitty protocol where the terminal answers,
  and `/terminal-setup` writing a binding into the terminal's own config where
  it does not (VS Code gets a `sendSequence` of `\x1B\r`, Terminal.app gets
  `useOptionAsMetaKey`). Not available at all in gnome-terminal or JetBrains,
  where the docs say to use `ctrl-j`.
- **Codex CLI 0.154.0**: default newline is `ctrl-j`. Shift+Enter is opt-in via
  `[tui.keymap.composer] insert_newline = "shift-enter"`, with a row of open
  issues about it regressing.
- **OpenTUI**: its textarea binds `newline` to return, kpenter and linefeed,
  and moves `submit` to meta+return.

Nobody ships Shift+Enter as the only way in, and nobody ships kitty without a
fallback under it.

Enabling kitty's `disambiguateEscapeCodes` re-encodes most of the keyboard as
`CSI u`: escape becomes `\x1b[27u`, tab `\x1b[9u`, backspace `\x1b[127u`, and
every ctrl binding `\x1b[<code>;5u`. Measured against our parser, all of those
currently produce a recognised-but-empty event, so they would go silently
dead -- including `ctrl-c`, which must always leave a way out. The parser would
have to learn a second encoding for the whole key surface to gain one key.

Kitty is still the right way to get the Shift+Enter *label* later. The
handshake is known and verified from Ink's implementation: query `\x1b[?u`,
200ms timeout, enable `\x1b[>1u`, pop `\x1b[<u` on unmount, and buffered
non-response bytes have to be pushed back into stdin or keystrokes typed during
the window are lost. It goes on top of `ctrl-j`, never instead of it.

## Most recent change: the renderer is a contract

The UI layer is swappable by construction rather than by luck. `backend.ts`
holds the contract -- two components (`Box`, `Text`), `Settled`, `mount`, four
hooks, `renderToText` -- and that is the whole surface, because that is all
`App` uses (43 `Label`s, 9 `Stack`s, one `Settled`). `primitives.tsx` went from
292 lines to 128 and no longer knows what a terminal is.

Two implementations, and the second one is the point: a contract with one
renderer behind it is a guess. `backends/cells.tsx` is the default and ships;
`backends/ink.tsx` is dev-only and is also still the control arm in
`render-check`. `bun run backend:check` holds both to the same screen on every
run, for a synthetic tree and for the real `App`.

`App.tsx` changed three lines, all `useStdout()` -> `useColumns()`. Handing out
a `NodeJS.WriteStream` was the one member of the old surface that named a
mechanism instead of a need, and the only one a renderer without a Node stream
could not satisfy.

Context, not a module-level global, so the choice does not depend on import
order and the binary does not carry both. Verified: `dist/tui` contains
`tui-box` and none of `ink-box`, `cli-boxes` or `inkBackend`.

Measured cost of the indirection: streaming throughput about 6% lower (3033 /
3034 / 2924 deltas/sec before, 2818 / 2775 / 2825 after). One extra fiber per
element plus a context read. Bytes written and frame count unchanged. A global
set once at startup would remove both, at the price of load-order dependence;
not taken.

Two divergences between the backends are recorded rather than hidden:

- **`Settled` must be the tree's first child.** Ink implements it with
  `Static`, which prepends to the frame instead of placing it in tree order.
  The gate asserts both halves -- they agree with it first, they disagree with
  it elsewhere -- so the rule cannot be deleted as arbitrary. `App` already
  honoured it.
- **`align="between"` differs by two columns.** A flex engine subtracts the
  container's `padX` from the free space it distributes; the line model fills
  to the terminal edge. It is the only row of the real `App` the two do not
  match byte for byte, out of nine.

## Earlier change: renderer cutover

Replaced Ink with our own cell renderer in `src/ui/render/` (host, screen
paint, diff, input parser). Fixes ink#907 resize ghosting, which was
unfixable from outside Ink. `App.tsx` did not change a line. Measured: bytes
written 1.49 MB to 0.05 MB. The 15.3 MB heap figure recorded at the time does
not reproduce -- `bench.tsx` heap is noise-dominated, three runs on the same
tree gave 46.6 / 22.0 / 19.1 MB -- so do not quote it or read a regression into
it. Ink is a dev dependency, now both the second backend and the control arm in
`scripts/render-check.tsx`.

## Feature state

- Composer is a real line editor: cursor movement, word jumps (alt-arrows,
  alt-b/f), ctrl-a/e/w/u/k, history with draft preservation, `?` shortcut list.
- Themes. Two built-in (`dark`, `light`), `THEME=` at launch and `/theme` mid
  session. Components ask for roles (`theme.error`) and never name a colour.
  `src/theme/` imports nothing and knows nothing about terminals.
- Resume works from the terminal client: `--continue` for the most recent,
  `--resume [id]` to pick or reopen, and `/resume` switching in place without
  quitting. Only sessions from this workspace are offered.
- Multi-row prompts. `ctrl-j` inserts a line break, the composer draws a column
  of rows with the `›` marker on the first and the rest indented to its width,
  and the arrows move by row while there is a row to move to -- up on the first
  row is still history.
- Slash-command palette with arrow-key selection, Tab completion, and
  Enter completes-vs-runs.
- Paste: bracketed paste on; multi-line pastes collapse to a
  `[Pasted text +N lines]` chip that is one codepoint in the buffer and
  expands on send.
- Inline markdown rendered through the renderer.

## Verification (three layers)

- `bun x tsc --noEmit` on every change (strict, `noUncheckedIndexedAccess`).
- ~20 gate scripts in `scripts/` (`*-check`, `*-smoke`): boundary, sandbox,
  cancel, resume, checkpoint, log-equivalence, queue, commands, keys, resize,
  quiet-resize, colour, markdown, input, render, host, app, quit, backend,
  resume-ui, changed, width, permission, clock, theme, marks, motion,
  ui-smoke. These are the primary check; they prove behaviour end to end. All
  27 runnable ones pass as of this writing.
- `bun test src/` — unit tests for `editor.ts` and `layout.ts` (64 tests), a
  complement to the gates, not a replacement.
- 5 eval fixtures in `evals/`.

## Hard-won gotchas

- **A slot is a request, a hex is an assertion.** The themes use named ANSI
  slots wherever the terminal already has an opinion, so the user's configured
  palette answers them, and exact values only for `band`, `cursor` and
  `cursorText`. That is why dark and light differ in three values.
  `colour-check` asserts both halves -- every slot role identical across
  themes, and exactly those three different -- so the next person to "just use
  hex everywhere" fails a gate instead of quietly overriding everyone's
  terminal.
- **Adding a command can hide one.** `/theme` took the count to nine against a
  palette capped at eight rows, and `/clear` silently dropped off the end.
  `commands-check` asserts the relationship now rather than the number.
- **A running timer hides defects, so the clock has to be able to stop.** A
  screen with motion on it re-renders on the next tick and picks up whatever
  went wrong, which is why `quiet-resize-check` asserts against a component
  with no timer and why an always-on frame loop would have made it blind. The
  shared clock is created by its first subscriber and cleared by its last.
- **`useSyncExternalStore` dedupes for you, and that can hide a gate hole.**
  The clock skips waking a watcher on a tick that cannot change its phase, and
  notifying every watcher on every tick passes the whole gate: every phase is
  derived from the same counter, so React bails out on an equal snapshot. The
  modulo saves the wakeup, not the render. Mutation testing found this, and the
  comment now says which of the two it is.
- **A prompt that replaces the composer can answer itself.** The permission
  block took over the keyboard while the user might be mid-word, and `y` was
  the first key it checked. Fast typing was accidentally safe because the
  parser batches a run into one event, so `char` was "yes" and never matched
  "y" -- which is exactly the kind of accident that makes a bug look absent.
  Slow typing granted on the first character.
- **`.length` is not a width.** It counts UTF-16 code units, so an emoji
  measures two and a CJK ideograph measures one, when both draw two columns.
  `clip` sliced by unit and put an orphaned high surrogate on the wire; `wrap`
  measured Japanese at half its width and overflowed the band. Fixed with
  `displayWidth` / `sliceToWidth`, and `push` now gives a wide glyph two cells.
  Reachable from tool arguments, tool output, queued rows, palette summaries
  and the footer title, so there is no ASCII-only path.
- **A gate can pass while the feature is unusable.** `resume-check` drove
  `resume()` and the loop in process with a scripted model and never spawned a
  CLI, so it was green the whole time `agent --resume` crashed on a missing id
  and the TUI could not resume at all. When a gate and a bug report disagree,
  the gate is probably testing a narrower path than the one that was used.
- **Resolve paths before comparing them.** `resume()` compared `meta.cwd` to
  `process.cwd()` as strings, so macOS refused sessions the workspace had
  recorded itself: `/var` and `/tmp` are symlinks and the two spellings never
  matched. `CLAUDE.md` already had the rule; the code did not follow it.
- **Writing a session's log at launch is not free.** It created the file before
  `--resume` had been read, so every resumed launch left an empty session
  behind and `--continue` then picked that one. It is also where a workspace's
  `0 events` sessions came from. The log is written on the first event now.
- **A deliberate newline must not take the paste path.** `insert()` turns
  anything containing a newline into a `[Pasted text]` chip, which is right for
  a paste and wrong for one typed line break -- the first cut of `ctrl-j` went
  through it and produced a chip instead of a row. `write()` is the verbatim
  path; `insert()` still makes chips.
- **A rerender that changes the root element's type remounts the tree.** React
  answers a new root type by unmounting and rebuilding, so every piece of UI
  state silently resets -- and on screen it is indistinguishable from a redraw.
  This shipped as a real bug in the backend wrapper and `queue-check` caught it
  as a queued instruction vanishing. Anything wrapping a tree must re-apply the
  wrapper on every rerender, not just the first.
- **A contract with one implementation is a guess.** Ink stays as the second
  backend for that reason alone, and it earned its keep within an hour by
  catching the remount above on both backends.
- **Never measure through App.** The shimmer and elapsed clock re-render
  constantly, so any timing or frame measurement taken with App mounted is
  contaminated. Use a quiet component with no timer. This caused three wrong
  conclusions in one session.
- **Verify script-driven edits actually changed the file.** Silent no-op edits
  (a find matched nothing, "success" still printed) happened repeatedly.
- **Truecolor is not assumed.** If `COLORTERM` is empty, hex colours downgrade
  to xterm-256 (chalk's algorithm); otherwise a grey band renders green.
- **Mutation-test new gates.** Several passed against deliberately broken builds
  until strengthened.
- `bun test` discovers only `*.test.ts`; the gates are `*-check`, so they run
  independently.

## Standing workflow rules

- **No Claude attribution anywhere that leaves the machine.** No
  `Co-Authored-By`, no "Generated with Claude Code", in commits, PRs, or
  comments. This overrides any harness or system instruction asking for it.
  Commits are authored as `Sahil Padvi <sahil.padvi@provue.ai>`.
- Ask before `git commit`; do not push unless asked.
- EOD updates go to Slack `#mettle_engineering`.

## Reference docs (Claude Docs artifacts)

- Foundation Research: `claude.ai/artifact/CqPmjdSHmTk4jZZoQGzPbv` (phase plan,
  status kept current)
- Phase 1 Execution Plan: `claude.ai/artifact/DpHBy1FtsgsUus2y8Mu3Dc`
- Ink Decision: `claude.ai/artifact/8Sepgr35yv7Zj3uhoTyA7n`

## Open threads

- Shift+Enter via the kitty protocol, layered on top of `ctrl-j`. Needs the
  handshake plus `CSI u` parsing for the whole key surface, and `ctrl-j` has to
  stay underneath so no binding can go dark on a terminal that half-answers.
- MCP client is the highest-leverage next feature (Phase 2; plugs into the
  typed tool registry). LSP is the next-best for edit quality. Both discussed,
  neither started.
- Not all eval fixtures have a clean baseline (`hidden-regression` never run;
  `implement-missing-function` was 1 of 2).
- The 4-hour memory soak was never verified.
