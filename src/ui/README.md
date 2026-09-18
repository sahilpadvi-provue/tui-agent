# ui

The terminal client. One subscriber to the event bus among several that could exist.

## What lives here

- **`backend.ts`** — the renderer contract, and the vocabulary (`Color`, `Key`) both sides share.
- **`backends/`** — one file per renderer. `cells.tsx` is the default and ships; `ink.tsx` is the second implementation and the control arm.
- **`primitives.tsx`** — the surface every screen is written against. Knows nothing about terminals.
- **`layout.ts`** — the spacing system, the `Span` type, and the tool verbs. Every column and blank row on screen comes from here.
- **`model.ts`** — view state as a fold over the event stream.
- **`markdown.tsx`** — inline markdown, so models' `**bold**` is not shown raw.
- **`App.tsx`** — the screen.

## Rules

**No screen knows how a frame reaches the terminal.** Every screen is written against `Stack`, `Label`, `Settled` and four hooks. Which renderer is behind them is a `Backend`, picked at `mount` and read from context, so a new renderer is a new file in `backends/` and nothing else moves. It survives only if nobody reaches past it: `primitives.tsx` and the backends are the only modules that may import `render/` or `ink`. Check imports in review.

**The contract is two elements and four hooks**, because that is all `App` uses: 43 `Label`s, 9 `Stack`s, one `Settled`, and `useKeys` / `usePaste` / `useColumns` / `useApp`. Anything wider is a renderer feature leaking into the screens.

**`Settled` must be the tree's first child.** Ink implements it with `Static`, which prepends its output to the frame rather than placing it in tree order, so anywhere else the two backends draw different screens. `scripts/backend-check.tsx` asserts both halves of that — they agree with it first, they disagree with it elsewhere — so the rule cannot be dropped as arbitrary.

**`useColumns` hands out the width, not the stream.** It used to be `useStdout`, and callers read `.columns` off `process.stdout`. That was the one member of this surface that named a mechanism rather than a need, and the only one a renderer without a Node stream behind it could not have satisfied.

**The default renderer is ours, in `render/`.** A grid the height of the content, with the terminal as a window onto its last rows; rows above that window are never addressed, so settled output still lands in the terminal's own scrollback. There is no erase-by-line-count step, which is what ink#907 was, so narrowing cannot leave ghosts.

**Ink is the second implementation, and that is the point.** A contract with one renderer behind it is a guess. `backends/ink.tsx` keeps it honest on every run through `backend:check`, and `scripts/render-check.tsx` still drives it as the control arm that shows the ghosting difference rather than asserting it. Ink is a dev dependency and nothing in `src/` imports that backend, so the shipped binary carries neither.

**A rerender must re-apply the backend provider.** Handing the backend a bare node changes the root element's type, and React answers that by unmounting the tree and building a new one — every piece of UI state, including a queued instruction, silently resets. It looks like a redraw. `scripts/queue-check.tsx` caught it and `backend:check` now guards it on both backends.

**A newline is a row break, not a cell.** The cell renderer used to keep it as a cell, which wrote a raw LF into the middle of a row the diff counted as one row, desynchronising every row index after it -- the same failure ink#907 was, arriving through the content instead of through a resize. `paint` breaks the row now, which is also what Ink does, so `backend:check` covers it.

**Known divergence: elastic fill.** `align="between"` differs by two columns between the two backends, because a flex engine subtracts the container's `padX` from the free space it distributes while the line model fills to the terminal edge. Measured, not a bug either side, and the only row of the real `App` the two do not match byte for byte.

**The UI never calls the runtime.** It subscribes to the bus and receives `onSubmit` / `onCancel` / `onPermission` from `cli/`. It holds no reference to the loop, executor or model.

**Only the last item can be live.** The loop emits strictly sequentially, so once a later item exists the one before it is finished, whatever its own flags say. An earlier rule stopped at the first item that did not *look* finished, which let one reasoning block without its completion event pin every item after it in the live region — and that region is redrawn whole each frame, so it grew past the terminal height and Ink could no longer erase what it had drawn. `scripts/resize-check.tsx` guards it.

**Settled output is append-only.** Items that can no longer change go to `Settled` and, under the Ink backend, are printed once and never redrawn. `countSettled` stops at the first live item so the list only ever grows. Re-keying or reordering it reprints the whole transcript — the documented way agent TUIs collapse.

**A resumed transcript is a fold over the other log, not a stored one.** `/resume` and `--resume` hand the UI a `seed` array and the reducer folds it from `initialState`, which keeps one code path between a live session and a resumed one: if the fold is wrong it is wrong live too, where somebody notices. A new array is the signal, so re-rendering with the same one does nothing.

**A session swap has to reset the printed-row bookkeeping.** `Settled` output is printed once and never reprinted, so leaving `printed` populated across a swap keeps rows from the session you left and counts the new one's rows as already drawn. `/clear` had this right; resume had to do the same thing.

**The session picker is the command palette's mechanism, reused.** `/resume ` with an empty argument lists sessions where the command list would be, filtered by id or by what the session was first asked, with the same arrow selection and the same row cap. The two lists are never open together: once the command is named and a space typed, the thing being chosen is a session. That is also why `/resume` completes to `/resume ` rather than running -- the space is what opens the picker.

**The picker takes display rows, not `SessionSummary`.** Reading the log directory stays in `cli/`, so `ui/` keeps its distance from `core/` and choosing a session still goes out through `onCommand` rather than through a new callback.

**The conversation still lives in `model.ts`, not the terminal.** Scrollback is where settled output is *displayed*; the event log remains the source of truth. Never read state back off the screen.

**Full-width chrome is fine now, and that is the point of the renderer.** The composer's two rules are the width of the terminal, which under Ink was exactly what leaked on every narrowing: it erased its last frame by logical line count while the terminal had already re-wrapped to physical rows. Removing the chrome fixed it and was rejected on how it looked. Owning the cells fixed it without that trade. `scripts/reflow-check.tsx` measured the old defect and is gone with it; `scripts/render-check.tsx` now shows the difference with Ink driven as a control arm.

**Inline, not alternate screen.** Settled output is printed once into the user's own scrollback, where they can scroll, search and copy it with the terminal they already know. An app that owns the whole screen cannot hand its history back. Under Ink this cost ink#907 — narrowing the terminal left ghost lines, with no upstream fix — which is what owning the cells removed.

**No fixed-height panes.** The app occupies exactly the rows it needs. Anything that reserves full height produces an empty band between the content and the prompt.

## The spacing system

Four numbers, in `layout.ts`. Anything new should replace one of them, not join them.

| | | |
| --- | --- | --- |
| `GUTTER` | 2 | Left page padding. Two so the transcript aligns with the composer's *text* rather than its border. |
| `STEP` | 2 | One indent level. |
| `MEASURE` | 88 | Where prose stops, however wide the terminal. |
| `OUTPUT_LINES` | 8 | Tool output kept on screen before a "more" marker. |

**Depth carries meaning**, so the conversation can be found without reading it:

```
  › what was said          depth 0 — the request, the answer
    ✓ what the agent did   depth 1 — tool calls, reasoning, errors
      what came back       depth 2 — tool output
```

**A rule closes an exchange; a blank row separates within one.** The rule costs the same single row a blank would have and reads as a harder boundary, which is what a new request is.

**A blank row is the separator within an exchange**, so it is spent where the reader changes what they are doing: before a new exchange, and when moving from the agent's work back to its answer. Consecutive tool calls are one continuous action and get none — spacing them out is what turns a session into a scroll. The rule lives in `gapBefore()` and depends only on an item and the one before it, which is what keeps the settled list append-only for `Static`.

**Blank rows in prose belong to the layout, not the model.** `wrap()` drops leading and trailing blanks and collapses runs to one, so the gap before the next thing on screen does not depend on how many newlines a model happened to end with. Paragraph breaks inside a message survive.

**Width is columns, never `.length`.** `.length` counts UTF-16 code units and is wrong in both directions: an emoji is two units and two columns, a CJK ideograph is one unit and two columns. Measuring with it put an orphaned high surrogate on the wire from `clip`, and let a line of Japanese through `wrap` at half its real width, overflowing the band. `charWidth` / `displayWidth` / `sliceToWidth` in `layout.ts` are the only correct way to measure, and `push` in `render/screen.ts` gives a wide glyph two cells and a combining mark none, so the grid counts what the terminal draws. ASCII short-circuits on the first comparison, because it is nearly all of it.

**A word too wide for a line of its own is broken; one that fits never is.** Word boundaries are what prose needs, but Japanese has no spaces, so a whole sentence arrives as one word. The break has a take-at-least-one-code-point guard: `sliceToWidth` returns nothing at width zero, and without it the loop would not terminate.

**Prose wraps; output and code clip.** Re-flowing a diff or a stack trace to a narrow measure destroys the alignment that makes it readable, so those are truncated at the available width instead.

## Weight

A terminal has one typeface, so hierarchy is colour, dim and bold — nothing else. A row carrying a single style flattens the distinctions worth making, so a `Line` is a sequence of `Span`s:

| | |
| --- | --- |
| Request | banded row, cyan `›` |
| Answer | plain |
| Tool call | coloured mark · **bold verb** · plain argument |
| Output, reasoning | dim, under a `└` |
| Status, chrome | dim |
| Footer | model yellow · repo and branch green · session title cyan |

The session title is taken from the first request and is the only elastic field in the footer: it takes what the fixed fields leave and disappears when that is nothing, rather than pushing the line past the terminal.

**Tool lines name the verb, not the tool** — `Ran npm test`, not `shell {"command":"npm test"}`. The tool's own name still identifies it in the log, where the distinction matters. Verbs live in `layout.ts`; a new tool without one falls back to its name.

**A placeholder must not look like text you typed.** It renders in an explicit grey rather than `dim`, because dim white stays close to white on many themes — that exact bug shipped once.

## The keyboard is never taken away

A turn can run for minutes. Blocking input for that long means the next instruction has to be held in the user's head until the agent finishes, so the composer stays editable throughout: Enter queues while a turn is running, queued lines show under the working indicator, and the queue flushes when the runtime goes idle.

This is why the working indicator is its own row rather than text inside the composer — the composer is needed for its actual job the whole time. `scripts/queue-check.tsx` drives real keystrokes through a busy app and is the guard.

## The composer is a line editor

The prompt carries a cursor index, not just a string. Everything else follows from that: the arrows, the word jumps, `ctrl-a`/`ctrl-e`, and the three kills are all slices around one number, so none of them can put the cursor somewhere the text does not go. `editor.ts` holds the two word-boundary functions and nothing else; dispatch stays in `App.tsx`, because a key-to-closure table with one caller is indirection, not structure.

**Words are whitespace-delimited**, the readline convention rather than the editor one. The composer holds prose and paths, and a punctuation-aware jump stops *inside* a path, which is never what was wanted.

**The cursor is a bar at the end of the line and a block inside it.** A bar between two characters reads as one of them.

**History keeps the draft.** Losing a half-written line to a stray up-arrow is what makes people stop trusting the up arrow, so the draft is saved on the way into history and put back on the way out the bottom. Commands go into history alongside prompts — recalling `/restore 4,5` is the point of having it.

**Arrows belong to the command list while it is open and to history otherwise**, which is why `esc` has to be able to close the list: without it, a `/` typed by accident takes the arrows hostage.

**`?` on an empty prompt lists the bindings**, and any key dismisses it. On a prompt with text in it, `?` is a question mark. Discoverability is the whole reason the bindings exist — one a user cannot find is one they do not have.

**Paste has its own channel, and that is not cosmetic.** A terminal in raw mode sends CR for a pasted line break — the same byte as Enter. Ink's parser refuses to split a multi-character chunk on CR, which hides the problem most of the time, but when a read boundary lands exactly on a line break the next chunk is a lone CR and the paste submits itself halfway through: measured, a three-line paste delivered as five writes fired `onSubmit` twice and lost the third line. Mounting `usePaste` puts the terminal into bracketed paste mode (`\x1b[?2004h`), which brackets the payload so it can never be read as a keypress. The gate asserts the escape sequence is actually written — injecting the markers by hand passes on a build that never asks for them.

**Pasted text is normalized to `\n` on the way in**, on both the paste channel and the typed one, because a terminal that ignores the bracketed-paste request still delivers a paste through `useInput` in chunks. Unnormalized, a pasted function renders as one run-on line and reaches the model full of `\r`.

**A pasted block is one character.** It is drawn as `[Pasted text #1 +13 lines]`, but in the prompt string it occupies a single private-use codepoint, and `pastes` maps that character to what was pasted. Backspace deletes it whole, the arrows step over it, and `ctrl-w` takes it as a word — none of which needs a rule, because there is no multi-character token to leave half of. Expansion happens on the way out and nowhere else, so history keeps the chip and a recalled line still reads as one line.

The alternative was to keep the label itself in the string and map label to payload. That looks identical and is worse: 25 characters pretending to be one object, defended by a special case in every editing binding, and the cost of missing one is silent, because a broken label stops matching its payload and the prompt submits the label text instead of the code. `scripts/keys-check.tsx` demonstrates the difference. Lengthening the mark to two characters fails eight of its checks, and the informative one is the payload: backspace takes only the first character, the second is stranded in the prompt, and what reaches the model is that stray character rather than the paste.

**The composer grows a row at a time, and `ctrl-j` is what grows it.** A paste can no longer put a newline in the prompt, so for a while there was no way to enter one and the composer was a single row. `ctrl-j` is the way back in.

It is `ctrl-j` and not Shift+Enter because in a terminal without the kitty keyboard protocol the two are the same byte: Shift+Enter sends `\r`, exactly as Enter does, and no application code can tell them apart. Every other agent CLI landed in the same place. Codex's default newline is `ctrl-j`; Claude Code offers `ctrl-j` and `\` then Enter in every terminal and treats Shift+Enter as a per-terminal enhancement on top, negotiated through the kitty protocol where the terminal answers and injected into the terminal's own config where it does not; OpenTUI's textarea binds newline to return, kpenter and linefeed, which is `ctrl-j` again, and moves submit to meta+return. Enabling the kitty protocol here would re-encode escape, tab, backspace and every ctrl binding as `CSI u`, so the parser would have to learn a second encoding for the whole keyboard before it gained one key — including `ctrl-c`, which must always leave a way out. That is the reason the cheap key came first.

`ctrl-j` does not take the paste path. Anything with a newline in it becomes a chip there, and one deliberate line break is not a block worth collapsing, so `write()` puts it in verbatim while `insert()` still makes chips out of pastes.

**The marker belongs to the first row.** The composer draws a column of rows with `›` on the first and the rest indented to its width, so a multi-row prompt reads as one block of text rather than a list of entries. That split happens in `App`, not in the renderer: the renderer knows nothing about the marker, and a row break alone would leave continuation rows flush against the border.

**The arrows move by row only while there is a row to move to.** Up on the first row is still history, which is what keeps that binding reachable on the single-row prompt this started as, and it is why `rowUp` returns `null` at the edge instead of clamping. Clamping would silently take the up arrow away from history, and the symptom would look like history being broken.

**There is no `ctrl-l`.** Clearing the screen would destroy the settled transcript permanently: it lives in the terminal's real scrollback, and `Static` will not reprint it. `/clear` starts a fresh conversation, which is the thing people actually want.

`scripts/keys-check.tsx` is the guard, and it probes every binding by the text that comes out of the composer rather than by finding the cursor in the frame — a cursor read off the rendered row passes on a build that draws it in the right place and edits in the wrong one.

## Colour and motion

**Commands are tinted, not parsed.** `highlightCommand` colours the binary, flags and paths — the three things a reader looks for. It decides nothing, so being wrong about an exotic quoting case costs nothing.

**The working indicator shimmers** rather than spinning: a brightness wave runs through the word itself, which says "alive" without spending a column or pulling the eye off the text. It ticks at 90ms, faster than the elapsed clock, because a second is long enough to look stopped.

**Verifying colour needs the escapes, not the text.** Two traps, both of which cost time here: `FORCE_COLOR=3` must be set or Ink strips every code and the output looks unstyled; and chalk usually runs at level 2, so a hex colour is emitted as 256-colour `38;5;N`, not truecolor `38;2;r;g;b`. Searching for the wrong form reads as "the feature is broken". Also note that per-character styling means a styled word never appears as a contiguous string in the buffer — grepping for it finds nothing.

## Rendering discipline

- Bound every output. Tool output is capped in the view model, not just at the tool.
- Syntax highlighting, when added, loads async and off the render path — it costs 200-300 ms to load and 50-100 ms per block.
- Stream incomplete markdown with a simpler component, then swap to the full one on completion.

## Gotchas

- Ink 7.1.1 has **no** `contentOffsetX` / `contentOffsetY`. Scrolling is userland — which is moot here, because the terminal owns scrolling now.
- `useInput` fires regardless of focus. `useFocus` / `useFocusManager` exist, but two components listening for arrow keys will both react. Arbitrate explicitly.
- `maxFps` is a `render()` option (default 30, we set 60). Claims that Ink is locked to ~32 fps describe the default, not a limit.
- Ctrl-C is not wired to Ink's own exit (`exitOnCtrlC: false`). We handle it: it cancels a running turn, and when idle the first press arms a confirmation and the second quits. Ctrl-D on an empty prompt quits immediately. Anything that takes over Ctrl-C must leave a way out — `scripts/quit-check.ts` is the guard.
