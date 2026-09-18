/**
 * The spacing system.
 *
 * A terminal has two units -- columns and rows -- so the scale is deliberately
 * tiny: one indent step, one blank row, one measure. Everything on screen
 * resolves to those. Any new number added here should replace one of them,
 * not join them.
 */

import type { Paint, Theme } from "../theme/index.ts";

/**
 * Columns of left page padding.
 *
 * Two, not one, so the transcript lines up with the composer's text rather
 * than with its border -- the composer is boxed, and one column of padding
 * inside a box reads as cramped.
 */
export const GUTTER = 2;

/** One level of nesting. Three levels exist and no more is needed. */
export const STEP = 2;

/**
 * Depth carries meaning, so the reader can find the conversation without
 * reading it:
 *   0  what was said      -- the user's request, the agent's answer
 *   1  what the agent did -- tool calls, reasoning, errors
 *   2  what came back     -- tool output
 */
export const DEPTH = { said: 0, did: 1, detail: 2 } as const;

/**
 * Prose stops here however wide the terminal is. Long measures are hard to
 * track back to the next line, and a coding session is mostly scanning.
 * Output and code are not re-wrapped to it -- they are truncated, because
 * re-flowing a diff or a stack trace destroys the alignment that makes it
 * readable.
 */
export const MEASURE = 88;

/** Tool output lines kept on screen. Below this a "more" marker costs more than it saves. */
export const OUTPUT_LINES = 8;

/**
 * A run of text with one weight.
 *
 * A terminal has one typeface, so hierarchy is built from colour, dim and
 * bold alone. A row that can only carry a single weight flattens exactly the
 * distinctions worth making -- which mark, which tool, which argument -- so a
 * line is a sequence of these instead.
 */
export type Span = {
  readonly text: string;
  /** What the role resolved to. The renderer turns it into codes. */
  readonly color?: Paint;
  readonly bg?: Paint;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
};

export type Line = {
  /** Used when `spans` is absent, and for measuring either way. */
  readonly text: string;
  /** Fills the whole row to the terminal edge. */
  /** The field colour, when this row is a banded one. */
  readonly band?: Paint;
  /** Draws a full-width rule instead of text. */
  readonly rule?: boolean;
  /** Terminal width, needed by anything that fills the row. */
  readonly width?: number;
  /** Styled runs, left to right. Overrides the line-level styling. */
  readonly spans?: Span[];
  readonly depth?: number;
  readonly color?: Paint;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /**
   * Render inline markdown, painting code spans with this.
   *
   * Carries its colour for the same reason `band` does: the renderer does its
   * own markdown pass for lines built by hand, and it has no theme to ask.
   */
  readonly md?: Paint;
};

/** Builds a line from spans, keeping `text` in sync for width maths. */
export function styled(depth: number, ...spans: (Span | null | undefined)[]): Line {
  const kept = spans.filter((s): s is Span => !!s && s.text !== "");
  return { text: kept.map((s) => s.text).join(""), spans: kept, depth };
}

export const BLANK: Line = { text: "" };

/** Columns available to text at a depth, given the terminal width. */
export function measureAt(depth: number, termWidth: number): number {
  const available = Math.max(20, termWidth - GUTTER * 2 - depth * STEP);
  return Math.min(MEASURE, available);
}

/**
 * Display columns, not code units.
 *
 * `.length` is wrong in both directions. An emoji is two code units and two
 * columns; a CJK ideograph is one unit and two columns. Measuring with it
 * split a surrogate pair inside `clip`, putting an orphaned high surrogate on
 * the wire, and let a line of Japanese through `wrap` unwrapped at about twice
 * the width it was measured against.
 *
 * A compact subset of Unicode's EastAsianWidth: the Wide and Fullwidth blocks
 * that occur in a coding session, plus zero for combining marks and the
 * joiners that build emoji sequences. Deliberately not the full table. Being
 * wrong about an unassigned plane costs one column; being wrong about
 * `.length` costs a broken byte.
 */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
];

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

const inAny = (code: number, ranges: readonly (readonly [number, number])[]): boolean => {
  for (const [lo, hi] of ranges) if (code >= lo && code <= hi) return true;
  return false;
};

/** Columns one code point occupies. ASCII short-circuits, since it is nearly all of it. */
export function charWidth(code: number): 0 | 1 | 2 {
  if (code < 0x0300) return 1;
  if (inAny(code, ZERO)) return 0;
  if (inAny(code, WIDE)) return 2;
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * The longest prefix of `s` that fits `cols` columns.
 *
 * Iterates code points, so it can never end inside a surrogate pair, and stops
 * before a wide glyph rather than half-drawing it.
 */
export function sliceToWidth(s: string, cols: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > cols) break;
    w += cw;
    out += ch;
  }
  return out;
}

/**
 * Wraps prose on word boundaries, preserving the blank lines between
 * paragraphs and nothing else.
 *
 * Models end messages with a varying number of newlines, and each one used to
 * become a blank row -- so the gap before the next thing on screen depended on
 * whitespace nobody chose. Leading and trailing blanks are dropped and runs
 * are collapsed to one, which makes the rhythm a property of the layout rather
 * than of the model's last token.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const line = para.trimEnd();
    if (displayWidth(line) <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      // A word too wide for a line of its own is broken. It is the one case
      // where honouring word boundaries costs more than it buys: Japanese has
      // no spaces, so a whole sentence arrives as a single word and used to
      // pass through unwrapped at roughly twice the measure, overflowing the
      // band. A word that fits is still never broken.
      if (displayWidth(word) > width) {
        if (current) {
          out.push(current);
          current = "";
        }
        let rest = word;
        while (displayWidth(rest) > width) {
          // At least one code point, or a width of zero would not terminate.
          const head = sliceToWidth(rest, width) || [...rest][0]!;
          out.push(head);
          rest = rest.slice(head.length);
        }
        current = rest;
        continue;
      }
      if (current && displayWidth(current + " " + word) > width) {
        out.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) out.push(current);
  }

  const collapsed: string[] = [];
  for (const line of out) {
    if (line === "" && collapsed.at(-1) === "") continue;
    collapsed.push(line);
  }
  while (collapsed[0] === "") collapsed.shift();
  while (collapsed.at(-1) === "") collapsed.pop();
  return collapsed;
}

/** Single-line clip. For output and code, where re-wrapping would mislead. */
export function clip(s: string, width: number): string {
  const flat = s.replace(/\t/g, "  ").replace(/\n/g, " ");
  if (displayWidth(flat) <= width) return flat;
  return sliceToWidth(flat, Math.max(0, width - 1)) + "…";
}

/**
 * The lines of tool output worth showing, plus a marker when any were left out.
 * Hiding a single line to save a row is not worth the marker that replaces it.
 */
export function outputLines(body: string, limit = OUTPUT_LINES): { lines: string[]; hidden: number } {
  const all = body.split("\n").filter((l) => l.trim() !== "");
  if (all.length <= limit + 1) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, limit), hidden: all.length - limit };
}

/**
 * What a tool call is doing, in the words the reader cares about.
 *
 * The raw argument object clipped at a fixed width usually cuts off exactly
 * the part that identifies the call -- a path or a command -- and leaves the
 * scaffolding. Naming the salient field per tool is denser and more useful.
 */
export function summariseCall(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);

  switch (name) {
    case "shell":
      return str("command") ?? "";
    case "read_file":
    case "write_file":
    case "edit_file":
      return str("path") ?? "";
    case "replace_lines": {
      const path = str("path") ?? "";
      const from = a["start_line"];
      const to = a["end_line"];
      return typeof from === "number" ? `${path}:${from}${to !== from ? `-${to}` : ""}` : path;
    }
    case "search": {
      const pattern = str("pattern") ?? "";
      const where = str("path");
      return where && where !== "." ? `${pattern}  in ${where}` : pattern;
    }
    case "list_files":
      return str("path") ?? ".";
    default: {
      const json = JSON.stringify(args ?? {});
      return json === "{}" ? "" : json;
    }
  }
}

/**
 * What the tool did, rather than what it is called.
 *
 * "shell" and "replace_lines" name the implementation; a reader scanning a
 * session wants the verb. The tool's own name still identifies it in the log,
 * where the distinction matters.
 */
const VERBS: Record<string, string> = {
  shell: "Ran",
  read_file: "Read",
  write_file: "Wrote",
  replace_lines: "Edited",
  edit_file: "Edited",
  search: "Searched",
  list_files: "Listed",
};

export function verbFor(tool: string): string {
  return VERBS[tool] ?? tool;
}

/** Shortens a path from the left, keeping the end that identifies it. */
export function shortenPath(p: string, width: number): string {
  if (p.length <= width) return p;
  const home = process.env.HOME;
  const short = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return short.length <= width ? short : "…" + short.slice(-(width - 1));
}

/**
 * A brightness wave moving through a word.
 *
 * A static label and a hung process look identical. A spinner says "alive"
 * but sits in one cell; a wave through the word itself says it without
 * spending a column or pulling the eye off the text. The trail is short so
 * the word stays readable rather than becoming an animation.
 */
// The ramp itself is theme data: it runs bright-to-dark on a dark ground and
// dark-to-bright on a light one, or the head vanishes and the signal reads
// backwards.

/**
 * How far past each end the highlight travels.
 *
 * Two less than the ramp, and the two are the whole point. Travel further and
 * every character clamps to the darkest shade for a run of frames: the word
 * becomes a static dark label, which is the one thing this exists to prevent.
 * Travel no further at all and the highlight pops onto the first character
 * instead of arriving.
 */
const lead = (ramp: readonly Paint[]) => ramp.length - 2;

export function shimmer(text: string, phase: number, ramp: readonly Paint[]): Span[] {
  const LEAD = lead(ramp);
  const span = text.length + LEAD * 2;
  const head = (phase % span) - LEAD;
  return [...text].map((ch, i) => {
    const distance = Math.abs(i - head);
    const shade = ramp[Math.min(distance, ramp.length - 1)]!;
    return { text: ch, color: shade };
  });
}

/**
 * Colours the parts of a command a reader actually looks for: what ran, which
 * flags, and which paths. Not a shell parser -- it never decides anything, it
 * only tints, so being wrong about an exotic quoting case costs nothing.
 */
export function highlightCommand(command: string, theme: Theme): Span[] {
  const out: Span[] = [];
  const tokens = command.split(/(\s+)/);
  let seenVerb = false;

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      out.push({ text: token });
      continue;
    }
    if (!seenVerb) {
      seenVerb = true;
      // The binary is the one word worth finding at a glance.
      out.push({ text: token, color: theme.name });
      continue;
    }
    // A path is a name, so it takes the same colour as the binary: the reader's
    // question is what the command touched, and the flags are never the answer.
    if (token.startsWith("-")) out.push({ text: token, dim: true });
    else if (token.includes("/") || token.includes(".")) out.push({ text: token, color: theme.name });
    else if (/^[|;&><]+$/.test(token)) out.push({ text: token, dim: true });
    else out.push({ text: token });
  }
  return out;
}
