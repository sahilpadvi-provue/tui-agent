# ui

The terminal client. One subscriber to the event bus among several that could exist.

## What lives here

- **`layout.ts`** — the spacing system, the `Span` type, and the tool verbs. Every column and blank row on screen comes from here.
- **`primitives.tsx`** — the only module that imports `ink`.
- **`model.ts`** — view state as a fold over the event stream.
- **`markdown.tsx`** — inline markdown, so models' `**bold**` is not shown raw.
- **`App.tsx`** — the screen.

## Rules

**Only `primitives.tsx` imports `ink`.** Every screen is written against `Stack`, `Label` and our hooks. This is what makes the renderer swappable for OpenTUI or a fork — and it survives only if nobody reaches for `ink` directly. Check imports in review.

**The UI never calls the runtime.** It subscribes to the bus and receives `onSubmit` / `onCancel` / `onPermission` from `cli/`. It holds no reference to the loop, executor or model.

**Only the last item can be live.** The loop emits strictly sequentially, so once a later item exists the one before it is finished, whatever its own flags say. An earlier rule stopped at the first item that did not *look* finished, which let one reasoning block without its completion event pin every item after it in the live region — and that region is redrawn whole each frame, so it grew past the terminal height and Ink could no longer erase what it had drawn. `scripts/resize-check.tsx` guards it.

**Settled output is append-only.** Items that can no longer change go to `Settled` (Ink's `Static`) and are printed once, never redrawn. `countSettled` stops at the first live item so the list only ever grows. Re-keying or reordering it reprints the whole transcript — the documented way agent TUIs collapse.

**The conversation still lives in `model.ts`, not the terminal.** Scrollback is where settled output is *displayed*; the event log remains the source of truth. Never read state back off the screen.

**Full-width chrome in the live region leaks rows on resize, and we accept that.** The composer's rules are the width of the terminal, and Ink erases its last frame by logical line count while the terminal re-wraps to physical rows — so every narrowing leaves two rows behind. See the README for the mechanism. Removing the chrome fixes it and was rejected on how it looked; the real fix is a cell-buffer renderer. `scripts/reflow-check.tsx` measures it and is expected to fail.

**Inline, not alternate screen.** Settled output is printed once into the user's own scrollback, where they can scroll, search and copy it with the terminal they already know. An app that owns the whole screen cannot hand its history back. The accepted cost is ink#907: narrowing the terminal can leave ghost lines, and there is no upstream fix.

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
