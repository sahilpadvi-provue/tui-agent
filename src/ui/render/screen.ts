/**
 * A grid of cells, tall enough to hold everything rendered so far.
 *
 * This is the whole reason the renderer exists. Ink builds a frame as one
 * string and repositions by counting its newlines, which stops being a row
 * count the moment the terminal re-wraps -- that is ink#907. A renderer that
 * owns cells has no such step: it knows what is in every row and addresses
 * rows, not lines.
 *
 * The grid is the height of the content, not of the terminal. The terminal is
 * a window onto its last `viewportRows` rows; everything above has scrolled
 * into the terminal's own scrollback and is deliberately unreachable.
 */

import type { Paint, Slot } from "../../theme/index.ts";
import { GUTTER, STEP, charWidth, type Line, type Span } from "../layout.ts";
import { blockStyle, segments } from "../markdown.tsx";
import { FILL } from "./host.ts";

export type Cell = {
  readonly char: string;
  /** The escape prefix this cell is drawn with. Empty means unstyled. */
  readonly sgr: string;
};

export type Screen = {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height` long. */
  readonly cells: readonly Cell[];
};

export const BLANK_CELL: Cell = { char: " ", sgr: "" };

export function cellAt(s: Screen, x: number, y: number): Cell {
  return s.cells[y * s.width + x] ?? BLANK_CELL;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.sgr === b.sgr;
}

/**
 * A slot's foreground code. Background is the same plus ten, which is what
 * ANSI already says, so there is one table rather than two.
 *
 * This is the whole of the terminal's half of the colour model: everything
 * above speaks roles, everything from here down speaks codes.
 */
const SLOT: Record<Slot, number> = {
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, grey: 90,
};

/**
 * `NO_COLOR`'s rule: present and non-empty suppresses, whatever the value.
 *
 * A capability, not a theme. `/theme` decides what the colours mean; this
 * decides whether any of them reach the terminal, and keeping the two apart is
 * what makes both testable on their own.
 *
 * Colour only. This UI's secondary tier rests on `dim`, so suppressing weight
 * as well would collapse three tiers into one and take the hierarchy with it.
 */
const NO_COLOUR = (process.env["NO_COLOR"] ?? "") !== "";

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Truecolor is not something to assume.
 *
 * A terminal that does not understand `48;2;r;g;b` does not ignore it -- it
 * reads the parameters as separate codes, and `42` among them is "background
 * green". That is why a #2a2a2a band came out bright green and the shimmer's
 * greys came out violet. Ink never hit this because chalk downgrades for it.
 *
 * COLORTERM is what advertises the support, so it is what decides.
 */
const TRUECOLOR = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

/** The nearest xterm-256 index: the greyscale ramp, else the 6x6x6 cube. */
function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return (
    16 +
    36 * Math.round((r / 255) * 5) +
    6 * Math.round((g / 255) * 5) +
    Math.round((b / 255) * 5)
  );
}

/** `38` for foreground, `48` for background. */
function extended(layer: 38 | 48, c: [number, number, number]): string {
  return TRUECOLOR
    ? `${layer};2;${c[0]};${c[1]};${c[2]}`
    : `${layer};5;${to256(c[0], c[1], c[2])}`;
}

/**
 * One prefix per cell rather than runs.
 *
 * Emitting a reset before every change costs bytes a run-length pass would
 * save, but it makes a cell self-describing, which is what lets the diff
 * repaint any single cell without knowing what was drawn before it.
 */
/** A `Paint` as this terminal says it, or nothing when it has no opinion. */
function code(p: Paint, layer: 38 | 48): number | string | undefined {
  if (p.kind === "inherit") return undefined;
  if (p.kind === "slot") return layer === 38 ? SLOT[p.slot] : SLOT[p.slot] + 10;
  const c = rgb(p.hex);
  return c === null ? undefined : extended(layer, c);
}

function sgrFor(style: {
  color?: Paint;
  bg?: Paint;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}): string {
  const codes: (number | string)[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (!NO_COLOUR) {
    if (style.color) {
      const c = code(style.color, 38);
      if (c !== undefined) codes.push(c);
    }
    if (style.bg) {
      const c = code(style.bg, 48);
      if (c !== undefined) codes.push(c);
    }
  }
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

/**
 * One cell per column, not one per code point.
 *
 * A wide glyph draws two columns, so it takes two cells: the glyph and an
 * empty continuation. `rowText` concatenates cell characters in order, so the
 * empty one contributes the column the glyph already occupies. Without it the
 * grid counts one column where the terminal draws two, and every cell after
 * it on the row is addressed one column early.
 *
 * A combining mark draws no column of its own, so it joins the cell before it
 * rather than claiming one.
 */
function push(out: Cell[], text: string, sgr: string): void {
  for (const char of text) {
    const w = charWidth(char.codePointAt(0)!);
    if (w === 0) {
      const prev = out[out.length - 1];
      if (prev) out[out.length - 1] = { char: prev.char + char, sgr: prev.sgr };
      continue;
    }
    out.push({ char, sgr });
    if (w === 2) out.push({ char: "", sgr });
  }
}

/**
 * A line as cells, before wrapping.
 *
 * Mirrors what `App`'s `Row` draws. Markdown lines are painted as plain text
 * here: the spike is about positioning, and inline emphasis changes no cell
 * positions.
 */
function lineCells(line: Line, width: number): Cell[] {
  if (line.rule) {
    const out: Cell[] = [];
    // A bordered Stack tints and dims its rule, so the style has to come from
    // the line. Hand-built rules carry neither and stay dim, as before.
    const style = line.color !== undefined || line.dim !== undefined
      ? { color: line.color, dim: line.dim }
      : { dim: true };
    push(out, "─".repeat(Math.max(0, Math.min(width, line.width ?? width))), sgrFor(style));
    return out;
  }

  // `depth` is App's indent model, resolved here for lines built by hand. A
  // line that came through the host has its indent already in its spans, and
  // padding it again would shift every row by a gutter.
  const pad = line.depth === undefined ? "" : " ".repeat(GUTTER + line.depth * STEP);
  const out: Cell[] = [];

  // Inline markdown, through the same two functions the Ink path uses, so a
  // model's `**bold**` cannot render as emphasis in one renderer and as raw
  // asterisks in the other.
  if (line.md) {
    const block = blockStyle(line.text);
    const base = { color: line.color, dim: line.dim, bold: block.bold };
    push(out, pad, sgrFor(base));
    for (const seg of segments(block.text)) {
      push(out, seg.text, sgrFor({
        ...base,
        bold: seg.bold ?? base.bold,
        italic: seg.italic,
        color: seg.code ? line.md : base.color,
      }));
    }
    return out;
  }

  const bg = line.band;

  push(out, pad, sgrFor({ bg }));

  const spans: readonly Span[] = line.spans ?? [
    { text: line.text, color: line.color, dim: line.dim, bold: line.bold },
  ];

  // A split row reserves whatever is left over for its gap, so the tail sits
  // against the right edge. Computed here because this is where the width is.
  const gap = spans.some((s) => s.text === FILL)
    ? Math.max(1, width - out.length - spans.reduce((n, s) => n + (s.text === FILL ? 0 : s.text.length), 0))
    : 0;

  for (const s of spans) {
    if (s.text === FILL) push(out, " ".repeat(gap), "");
    else push(out, s.text, sgrFor({ ...s, bg: s.bg ?? bg }));
  }

  if (line.band) {
    const fill = Math.max(0, (line.width ?? width) - out.length);
    push(out, " ".repeat(fill), sgrFor({ bg }));
  }
  return out;
}

/**
 * A newline is a row break, not a cell.
 *
 * Left as a cell it is written as a raw LF into the middle of a row the diff
 * believes is one row, so every row index after it is wrong -- the same
 * desynchronisation ink#907 was, arriving through the content instead of
 * through a resize. Ink splits here too, so this is also what keeps the two
 * backends drawing the same screen.
 */
function breakRows(cells: Cell[]): Cell[][] {
  if (!cells.some((c) => c.char === "\n")) return [cells];
  const out: Cell[][] = [];
  let row: Cell[] = [];
  for (const cell of cells) {
    if (cell.char === "\n") {
      out.push(row);
      row = [];
      continue;
    }
    row.push(cell);
  }
  out.push(row);
  return out;
}

/**
 * Lines to a grid.
 *
 * A line wider than the terminal becomes as many rows as it needs, which is
 * what the terminal would have done to it anyway. Doing it here rather than
 * letting the terminal do it is what keeps a row index meaning one row.
 */
export function paint(lines: readonly Line[], width: number): Screen {
  const rows: Cell[][] = [];
  for (const line of lines) {
    const cells = lineCells(line, width);
    if (cells.length === 0) {
      rows.push([]);
      continue;
    }
    for (const segment of breakRows(cells)) {
      if (segment.length === 0) {
        rows.push([]);
        continue;
      }
      for (let i = 0; i < segment.length; i += width) rows.push(segment.slice(i, i + width));
    }
  }

  const cells: Cell[] = new Array(width * rows.length).fill(BLANK_CELL);
  rows.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (x < width) cells[y * width + x] = cell;
    });
  });
  return { width, height: rows.length, cells };
}
