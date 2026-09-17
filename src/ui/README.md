# ui

The terminal client. One subscriber to the event bus among several that could exist.

## What lives here

- **`layout.ts`** — the spacing system. Every column and blank row on screen comes from here.
- **`primitives.tsx`** — the only module that imports `ink`.
- **`model.ts`** — view state as a fold over the event stream.
- **`markdown.tsx`** — inline markdown, so models' `**bold**` is not shown raw.
- **`App.tsx`** — the screen.

## Rules

**Only `primitives.tsx` imports `ink`.** Every screen is written against `Stack`, `Label` and our hooks. This is what makes the renderer swappable for OpenTUI or a fork — and it survives only if nobody reaches for `ink` directly. Check imports in review.

**The UI never calls the runtime.** It subscribes to the bus and receives `onSubmit` / `onCancel` / `onPermission` from `cli/`. It holds no reference to the loop, executor or model.

**Settled output is append-only.** Items that can no longer change go to `Settled` (Ink's `Static`) and are printed once, never redrawn. `countSettled` stops at the first live item so the list only ever grows. Re-keying or reordering it reprints the whole transcript — the documented way agent TUIs collapse.

**The conversation still lives in `model.ts`, not the terminal.** Scrollback is where settled output is *displayed*; the event log remains the source of truth. Never read state back off the screen.

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

**A blank row is the only separator this UI has**, so it is spent where the reader changes what they are doing: before a new exchange, and when moving from the agent's work back to its answer. Consecutive tool calls are one continuous action and get none — spacing them out is what turns a session into a scroll. The rule lives in `gapBefore()` and depends only on an item and the one before it, which is what keeps the settled list append-only for `Static`.

**Prose wraps; output and code clip.** Re-flowing a diff or a stack trace to a narrow measure destroys the alignment that makes it readable, so those are truncated at the available width instead.

## Rendering discipline

- Bound every output. Tool output is capped in the view model, not just at the tool.
- Syntax highlighting, when added, loads async and off the render path — it costs 200-300 ms to load and 50-100 ms per block.
- Stream incomplete markdown with a simpler component, then swap to the full one on completion.

## Gotchas

- Ink 7.1.1 has **no** `contentOffsetX` / `contentOffsetY`. Scrolling is userland — which is moot here, because the terminal owns scrolling now.
- `useInput` fires regardless of focus. `useFocus` / `useFocusManager` exist, but two components listening for arrow keys will both react. Arbitrate explicitly.
- `maxFps` is a `render()` option (default 30, we set 60). Claims that Ink is locked to ~32 fps describe the default, not a limit.
- Ctrl-C is not wired to Ink's own exit (`exitOnCtrlC: false`). We handle it: it cancels a running turn, and when idle the first press arms a confirmation and the second quits. Ctrl-D on an empty prompt quits immediately. Anything that takes over Ctrl-C must leave a way out — `scripts/quit-check.ts` is the guard.
