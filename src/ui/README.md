# ui

The terminal client. One subscriber to the event bus among several that could exist.

## What lives here

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

## Rendering discipline

- Bound every output. Tool output is capped in the view model, not just at the tool.
- Syntax highlighting, when added, loads async and off the render path — it costs 200-300 ms to load and 50-100 ms per block.
- Stream incomplete markdown with a simpler component, then swap to the full one on completion.

## Gotchas

- Ink 7.1.1 has **no** `contentOffsetX` / `contentOffsetY`. Scrolling is userland — which is moot here, because the terminal owns scrolling now.
- `useInput` fires regardless of focus. `useFocus` / `useFocusManager` exist, but two components listening for arrow keys will both react. Arbitrate explicitly.
- `maxFps` is a `render()` option (default 30, we set 60). Claims that Ink is locked to ~32 fps describe the default, not a limit.
- Ctrl-C is not wired to exit (`exitOnCtrlC: false`) — it cancels the running turn.
