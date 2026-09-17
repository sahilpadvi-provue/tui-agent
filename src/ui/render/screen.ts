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

import type { Color } from "../primitives.tsx";
import { GUTTER, STEP, type Line, type Span } from "../layout.ts";

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

const FG: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33,
  blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, grey: 90,
};

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * One prefix per cell rather than runs.
 *
 * Emitting a reset before every change costs bytes a run-length pass would
 * save, but it makes a cell self-describing, which is what lets the diff
 * repaint any single cell without knowing what was drawn before it.
 */
function sgrFor(style: {
  color?: Color | string;
  bg?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}): string {
  const codes: (number | string)[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.color) {
    const named = FG[style.color];
    if (named !== undefined) codes.push(named);
    else {
      const c = rgb(style.color);
      if (c) codes.push(`38;2;${c[0]};${c[1]};${c[2]}`);
    }
  }
  if (style.bg) {
    const c = rgb(style.bg);
    if (c) codes.push(`48;2;${c[0]};${c[1]};${c[2]}`);
  }
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function push(out: Cell[], text: string, sgr: string): void {
  for (const char of text) out.push({ char, sgr });
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
    push(out, "─".repeat(Math.max(0, Math.min(width, line.width ?? width))), sgrFor({ dim: true }));
    return out;
  }

  // `depth` is App's indent model, resolved here for lines built by hand. A
  // line that came through the host has its indent already in its spans, and
  // padding it again would shift every row by a gutter.
  const pad = line.depth === undefined ? "" : " ".repeat(GUTTER + line.depth * STEP);
  const out: Cell[] = [];
  const bg = line.band ? BAND : undefined;

  push(out, pad, sgrFor({ bg }));

  const spans: readonly Span[] = line.spans ?? [
    { text: line.text, color: line.color, dim: line.dim, bold: line.bold },
  ];
  for (const s of spans) push(out, s.text, sgrFor({ ...s, bg: s.bg ?? bg }));

  if (line.band) {
    const fill = Math.max(0, (line.width ?? width) - out.length);
    push(out, " ".repeat(fill), sgrFor({ bg }));
  }
  return out;
}

/** One step off the terminal's own background: enough to read as a field. */
const BAND = "#2a2a2a";

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
    for (let i = 0; i < cells.length; i += width) rows.push(cells.slice(i, i + width));
  }

  const cells: Cell[] = new Array(width * rows.length).fill(BLANK_CELL);
  rows.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (x < width) cells[y * width + x] = cell;
    });
  });
  return { width, height: rows.length, cells };
}
