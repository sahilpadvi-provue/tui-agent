/**
 * Two grids to an escape sequence.
 *
 * Everything here rests on one invariant: **between frames the cursor sits at
 * column 0 of the row immediately below the last painted row.** Growth is
 * emitted as newlines from there, so when the terminal scrolls, that resting
 * row scrolls with it and every relative move stays correct. This is what
 * replaces Ink's erase-by-line-count, and it is why narrowing the terminal
 * cannot leave a stack of ghosts behind.
 *
 * Positions are counted as rows *above rest* rather than as grid indices,
 * because that is the quantity the escape sequences actually take, and it
 * stays meaningful across a scroll.
 *
 * Rows above the viewport are never addressed. They belong to the terminal's
 * scrollback now, which is the same reason a real terminal does not reflow its
 * own history.
 */

import { cellAt, sameCell, type Screen } from "./screen.ts";

const RESET = "\x1b[0m";
const ERASE_BELOW = "\x1b[J";
const ERASE_LINE = "\x1b[2K";
const ERASE_LINE_RIGHT = "\x1b[K";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

/**
 * Every cell up to the last one that carries anything, then an erase.
 *
 * The row is not padded out to the terminal's width. A row written to the full
 * width is a row that re-wraps the moment the terminal narrows, and every
 * re-wrapped row is one more the terminal pushes out of view before any
 * renderer is consulted. Trailing blanks cost nothing to omit and the erase
 * clears whatever was there before, so nothing goes stale.
 */
function rowText(s: Screen, y: number): string {
  let last = -1;
  for (let x = s.width - 1; x >= 0; x--) {
    const cell = cellAt(s, x, y);
    if (cell.char !== " " || cell.sgr !== "") {
      last = x;
      break;
    }
  }

  let out = "";
  let sgr = "";
  for (let x = 0; x <= last; x++) {
    const cell = cellAt(s, x, y);
    if (cell.sgr !== sgr) {
      out += RESET + cell.sgr;
      sgr = cell.sgr;
    }
    out += cell.char;
  }
  // Reset before erasing: erase-in-line paints with the current background,
  // so a banded row would otherwise fill to the edge with its own colour.
  return out + RESET + ERASE_LINE_RIGHT;
}

function rowsDiffer(a: Screen, b: Screen, y: number): boolean {
  if (y >= a.height || y >= b.height) return true;
  for (let x = 0; x < b.width; x++) {
    if (!sameCell(cellAt(a, x, y), cellAt(b, x, y))) return true;
  }
  return false;
}

class Writer {
  #out = "";
  /**
   * Rows between the cursor and *this frame's* rest row. Zero means at rest,
   * negative means below it -- which is where a frame starts when the content
   * shrank, since the cursor is still parked under the taller previous frame.
   */
  #above: number;

  constructor(above = 0) {
    this.#above = above;
  }

  raw(s: string): void {
    this.#out += s;
  }

  /**
   * Newlines, not cursor-down: at the bottom of the terminal only a newline
   * scrolls, and scrolling is how a row leaves for the scrollback.
   */
  grow(rows: number): void {
    this.raw("\r" + "\n".repeat(rows));
    this.#above = 0;
  }

  seek(above: number): void {
    const delta = above - this.#above;
    if (delta > 0) this.raw(`\x1b[${delta}A`);
    else if (delta < 0) this.raw(`\x1b[${-delta}B`);
    this.raw("\r");
    this.#above = above;
  }

  /** The trailing CR also resolves the pending wrap a full-width row leaves. */
  paint(s: Screen, y: number, height: number): void {
    this.seek(height - y);
    this.raw(rowText(s, y) + "\r");
  }

  finish(): string {
    this.seek(0);
    return this.#out;
  }
}

/**
 * A repaint of the visible window, for the first frame and for a width change.
 *
 * The erase walks up **one screen's worth of rows, not one frame's worth**,
 * and that distinction is the entire fix. After a width change the terminal
 * has already re-wrapped the old frame, so it occupies more rows than it has
 * lines and no count derived from the frame can be trusted -- erasing by the
 * frame's height is precisely the arithmetic that leaves ink#907's ghosts. A
 * screen's worth cannot be an undercount, because the old frame cannot be
 * taller than the screen it was drawn on.
 *
 * Whatever sits above that is scrollback the terminal reflowed itself, which
 * is its business and not ours.
 */
function repaint(prev: Screen | null, next: Screen, viewportRows: number): string {
  const w = new Writer();
  if (prev) {
    for (let i = 0; i < viewportRows; i++) w.raw(ERASE_LINE + "\x1b[1A");
    w.raw("\r");
  }
  w.raw(ERASE_BELOW);

  const firstVisible = Math.max(0, next.height - viewportRows);
  for (let y = firstVisible; y < next.height; y++) {
    if (y > firstVisible) w.raw("\n");
    w.raw(rowText(next, y) + "\r");
  }
  w.raw("\r\n");
  return w.finish();
}

export function renderFrame(
  prev: Screen | null,
  next: Screen,
  viewportRows: number,
): string {
  if (!prev || prev.width !== next.width) return repaint(prev, next, viewportRows);

  const w = new Writer(next.height - prev.height);
  if (next.height > prev.height) {
    w.grow(next.height - prev.height);
  } else if (next.height < prev.height) {
    w.seek(0);
    w.raw(ERASE_BELOW);
  }

  const firstVisible = Math.max(0, next.height - viewportRows);
  for (let y = firstVisible; y < next.height; y++) {
    if (rowsDiffer(prev, next, y)) w.paint(next, y, next.height);
  }
  return w.finish();
}
