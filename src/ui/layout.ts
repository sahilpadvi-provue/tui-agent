/**
 * The spacing system.
 *
 * A terminal has two units -- columns and rows -- so the scale is deliberately
 * tiny: one indent step, one blank row, one measure. Everything on screen
 * resolves to those. Any new number added here should replace one of them,
 * not join them.
 */

import type { Color } from "./primitives.tsx";

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
  /** A named colour, or a hex string for shades the palette does not name. */
  readonly color?: Color | string;
  readonly bg?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
};

export type Line = {
  /** Used when `spans` is absent, and for measuring either way. */
  readonly text: string;
  /** Fills the whole row to the terminal edge. */
  readonly band?: boolean;
  /** Draws a full-width rule instead of text. */
  readonly rule?: boolean;
  /** Terminal width, needed by anything that fills the row. */
  readonly width?: number;
  /** Styled runs, left to right. Overrides the line-level styling. */
  readonly spans?: Span[];
  readonly depth?: number;
  readonly color?: Color;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /** Render inline markdown. Prose only; never output or code. */
  readonly md?: boolean;
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
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      if (current && (current + " " + word).length > width) {
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
  return flat.length > width ? flat.slice(0, width - 1) + "…" : flat;
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
const SHIMMER = ["#ffffff", "#d4d4d4", "#a0a0a0", "#7a7a7a", "#5f5f5f"] as const;

export function shimmer(text: string, phase: number): Span[] {
  const span = text.length + SHIMMER.length * 2;
  const head = phase % span;
  return [...text].map((ch, i) => {
    const distance = Math.abs(i - head);
    const shade = SHIMMER[Math.min(distance, SHIMMER.length - 1)]!;
    return { text: ch, color: shade };
  });
}

/**
 * Colours the parts of a command a reader actually looks for: what ran, which
 * flags, and which paths. Not a shell parser -- it never decides anything, it
 * only tints, so being wrong about an exotic quoting case costs nothing.
 */
export function highlightCommand(command: string): Span[] {
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
      out.push({ text: token, color: "cyan" });
      continue;
    }
    if (token.startsWith("-")) out.push({ text: token, color: "yellow" });
    else if (token.includes("/")) out.push({ text: token, dim: true });
    else if (/^[|;&><]+$/.test(token)) out.push({ text: token, color: "magenta" });
    else out.push({ text: token });
  }
  return out;
}
