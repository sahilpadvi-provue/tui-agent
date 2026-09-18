# theme

What the product means by a colour, and nothing about how one is drawn.

## What lives here

- **`index.ts`** — the roles, the `Paint` union, and the two built-in themes.

## Rules

**A role is a meaning, not a colour.** `success` rather than `green`. A component asks for `theme.error` and never learns what it looks like, which is what makes a theme data rather than a refactor.

**Nothing here knows what a terminal is.** No ANSI codes, no capability checks, no `process.stdout`. `src/ui/render/screen.ts` turns a `Paint` into SGR and `src/ui/backends/ink.tsx` turns the same `Paint` into Ink's props — two renderers, one model. A third would import this unchanged, which is the reason it is not under `ui/`.

**A slot is a request; a hex is an assertion.** A named colour in a terminal is filled by the user's own theme, so `slot("cyan")` inherits what they configured and `rgb("#89dceb")` overrides it on every path on screen. The built-in themes use slots wherever the terminal already has an opinion, and exact values only for the three places it does not: `band`, `cursor` and `cursorText`.

That is why dark and light differ in three values. It is the design working, not a limitation of it — and `colour-check` asserts both halves, that every slot role is identical across themes and that exactly those three differ.

**The union keeps the other answer available.** A theme *can* answer a role with `rgb`, and neither the renderer nor the role vocabulary changes when one does. None does today.

**`NO_COLOR` is not here.** A theme says what a thing means; a capability says whether any of it reaches the terminal. Folding them together is how you get a role called `plain-when-suppressed`. It lives in `sgrFor`.

**The shimmer ramp is five stops and the type says so.** `shimmer()` derives its lead from `ramp.length - 2`, so a four- or six-stop ramp changes the motion while looking like it changed a colour. The tuple is what stops a theme silently reintroducing a bug `layout.test.ts` guards.

## Adding a role

Only when a genuinely distinct meaning cannot be said with the ones here. `cursorText` earned its place because it must *oppose* another value — the cursor is light on a dark theme and dark on a light one, so `text` is wrong in both. A border, a selection and a heading did not: they are `warning`, `band`, and `text` plus bold.
