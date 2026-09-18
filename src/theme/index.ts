/**
 * What the product means by a colour, in terms no renderer owns.
 *
 * The flow is role -> theme -> renderer -> terminal, and each arrow matters.
 * A component asks for `theme.error`; the theme answers with a `Paint`; the
 * renderer turns that into whatever its surface speaks. Nothing here knows
 * what a terminal is, so a second renderer imports the same roles rather than
 * inventing its own -- which is the whole reason this is not `src/ui/`.
 *
 * The role names are not new. They are the meanings the palette work settled
 * on, one per colour, promoted from a convention into a type:
 *
 *   name     a name from your project: a path, a command, a code span
 *   success  it worked
 *   error    it failed
 *   warning  you must decide, now
 *   muted    chrome, and text that is not text you typed
 *   text     whatever the surface's own foreground is
 */

/**
 * A colour, as far as this layer is willing to say.
 *
 * `slot` rather than a hex for everything is the load-bearing choice. A named
 * colour in a terminal is a slot the user's own theme fills, so asking for
 * `slot: "cyan"` inherits the palette they configured, while asking for
 * `#89dceb` overrides it on every path and command on screen. That would be a
 * regression dressed as a feature, so the built-in themes use slots wherever
 * the terminal already has an opinion and exact values only where it does not.
 *
 * The union is what keeps the other option open: a future theme can answer a
 * role with `rgb` instead, and neither the renderer nor the role vocabulary
 * changes. Today none does.
 */
export type Paint =
  | { readonly kind: "inherit" }
  | { readonly kind: "slot"; readonly slot: Slot }
  | { readonly kind: "rgb"; readonly hex: string };

/** The colours a surface is expected to have an opinion about already. */
export type Slot = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "grey";

export const inherit: Paint = { kind: "inherit" };
export const slot = (s: Slot): Paint => ({ kind: "slot", slot: s });
export const rgb = (hex: string): Paint => ({ kind: "rgb", hex });

/** Five stops, head first. The length is load-bearing; see `Theme.shimmer`. */
export type Ramp = readonly [Paint, Paint, Paint, Paint, Paint];

export type ThemeId = "dark" | "light";

export type Theme = {
  readonly id: ThemeId;
  /** The surface's own foreground. Not a colour, an absence of one. */
  readonly text: Paint;
  readonly muted: Paint;
  readonly name: Paint;
  readonly success: Paint;
  readonly error: Paint;
  readonly warning: Paint;
  /** One step off the surface's own ground: a field, not a colour. */
  readonly band: Paint;
  readonly cursor: Paint;
  /**
   * Text drawn on the cursor block.
   *
   * Its own role because it is the one value that must oppose another: the
   * cursor is light on a dark theme and dark on a light one, so `text` is
   * exactly the wrong answer in both.
   */
  readonly cursorText: Paint;
  /**
   * The liveness ramp, head first. A sequence, so not one of the roles.
   *
   * Exactly five, and the tuple is the point rather than pedantry: `shimmer`
   * derives its lead from `ramp.length - 2`, and those two are what stop the
   * wave flattening at the ends and popping onto the first character. A theme
   * supplying four stops or six would change the motion while looking like it
   * changed a colour, and silently reintroduce a bug `layout.test.ts` guards.
   */
  readonly shimmer: Ramp;
};

/** Every role that answers with a single `Paint`. For anything that iterates. */
export const ROLES = [
  "text", "muted", "name", "success", "error", "warning",
  "band", "cursor", "cursorText",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * The two differ in three values, and that is the honest shape of it: the
 * terminal already themes the rest. Anything using a slot is deliberately
 * identical in both.
 */
export const dark: Theme = {
  id: "dark",
  text: inherit,
  muted: slot("grey"),
  name: slot("cyan"),
  success: slot("green"),
  error: slot("red"),
  warning: slot("yellow"),
  band: rgb("#2a2a2a"),
  cursor: rgb("#c8c8c8"),
  cursorText: rgb("#000000"),
  shimmer: [rgb("#ffffff"), rgb("#d4d4d4"), rgb("#a0a0a0"), rgb("#7a7a7a"), rgb("#5f5f5f")],
};

export const light: Theme = {
  id: "light",
  text: inherit,
  muted: slot("grey"),
  name: slot("cyan"),
  success: slot("green"),
  error: slot("red"),
  warning: slot("yellow"),
  // One step off white, as the dark band is one step off black. On a light
  // terminal the dark band was near-black behind near-black text.
  band: rgb("#e8e8e8"),
  cursor: rgb("#383838"),
  cursorText: rgb("#ffffff"),
  // Reversed, because the head is the bright part of the wave on a dark
  // ground and the dark part on a light one. Left as it was, the liveness
  // signal reads backwards: the head vanishes and only the tail shows.
  shimmer: [rgb("#1a1a1a"), rgb("#3d3d3d"), rgb("#6b6b6b"), rgb("#8a8a8a"), rgb("#a0a0a0")],
};

export const THEMES: readonly Theme[] = [dark, light];

/** The theme by name, or `undefined` so the caller decides what to say. */
export function themeNamed(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}
