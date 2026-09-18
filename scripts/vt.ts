/**
 * A terminal, small enough to assert against.
 *
 * Ghosting is a terminal effect: a line wider than the new width becomes two
 * rows, so a renderer that erases by line count leaves the surplus behind.
 * Proving anything about it needs something that holds rows, scrolls, and
 * re-wraps on resize the way a real terminal does.
 */

import { PassThrough, Writable } from "node:stream";

export class Term {
  cols: number;
  rows: number;
  scrollback: string[] = [];
  screen: string[][];
  r = 0;
  c = 0;
  /**
   * Which rows ran off the right edge into the next one.
   *
   * A resize re-wraps a soft row and leaves a hard one alone, which is the
   * difference between a terminal and a buffer of strings. Without it the
   * model rebuilds every row from scratch, and a rebuild cannot hold the
   * stranded ink a renderer failed to erase -- the model deduplicates the
   * defect on its way through and reports green.
   */
  #softBack: boolean[] = [];
  #softScreen: boolean[];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.#softScreen = Array(rows).fill(false);
  }

  #blank(): string[] {
    return Array(this.cols).fill(" ");
  }

  #scroll(): void {
    this.scrollback.push((this.screen.shift() ?? []).join("").trimEnd());
    this.#softBack.push(this.#softScreen.shift() ?? false);
    this.screen.push(this.#blank());
    this.#softScreen.push(false);
  }

  #newline(): void {
    if (this.r >= this.rows - 1) this.#scroll();
    else this.r++;
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(data.slice(i));
        if (!m) continue;
        const n = parseInt(m[2] ?? "", 10) || (m[2] === "" ? 1 : 0);
        // Private modes (cursor visibility, bracketed paste) change no cells.
        const cmd = m[1] === "?" ? "" : m[3];
        if (cmd === "A") this.r = Math.max(0, this.r - n);
        else if (cmd === "B") this.r = Math.min(this.rows - 1, this.r + n);
        else if (cmd === "K") this.#eraseLine(m[2] === "2");
        else if (cmd === "J") this.#eraseBelow();
        i += m[0].length - 1;
        continue;
      }
      if (ch === "\r") { this.c = 0; continue; }
      if (ch === "\n") { this.#newline(); continue; }
      if (this.c >= this.cols) { this.#softScreen[this.r] = true; this.c = 0; this.#newline(); }
      this.screen[this.r]![this.c] = ch;
      this.c++;
    }
  }

  #eraseLine(whole: boolean): void {
    const row = this.screen[this.r]!;
    for (let x = whole ? 0 : this.c; x < this.cols; x++) row[x] = " ";
  }

  #eraseBelow(): void {
    this.#eraseLine(false);
    for (let y = this.r + 1; y < this.rows; y++) { this.screen[y] = this.#blank(); this.#softScreen[y] = false; }
  }

  /**
   * What a real terminal does on a resize.
   *
   * Two properties matter and the earlier version had neither. Only
   * soft-wrapped rows are re-wrapped -- a hard-terminated row is left as its
   * own row, which is why a rebuild of every line is not the same thing. And
   * the cursor travels with the row it is sitting on rather than being clamped
   * to its old index, because a displaced cursor is the condition the renderer
   * cannot see and therefore the condition worth modelling.
   */
  resize(cols: number, rows?: number): void {
    const text = [...this.scrollback, ...this.screen.map((r) => r.join("").trimEnd())];
    const soft = [...this.#softBack, ...this.#softScreen];
    const cursorRow = this.scrollback.length + this.r;

    // Rows joined back into the logical lines they were wrapped from, so the
    // cursor's row can be found again after the re-wrap.
    type Logical = { text: string; cursorAt: number | null };
    const logical: Logical[] = [];
    let buf = "";
    let at: number | null = null;
    for (let i = 0; i < text.length; i++) {
      if (i === cursorRow) at = buf.length + Math.min(this.c, cols);
      buf += text[i] ?? "";
      if (!soft[i]) { logical.push({ text: buf, cursorAt: at }); buf = ""; at = null; }
    }
    if (buf !== "" || at !== null) logical.push({ text: buf, cursorAt: at });

    if (rows !== undefined) this.rows = rows;
    this.cols = cols;

    const out: string[] = [];
    const outSoft: boolean[] = [];
    let cursorOut = 0;
    let cursorCol = this.c;
    for (const line of logical) {
      const pieces: string[] = [];
      for (let i = 0; i < line.text.length; i += cols) pieces.push(line.text.slice(i, i + cols));
      if (pieces.length === 0) pieces.push("");
      if (line.cursorAt !== null) {
        cursorOut = out.length + Math.min(Math.floor(line.cursorAt / cols), pieces.length - 1);
        cursorCol = line.cursorAt % cols;
      }
      for (const [i, piece] of pieces.entries()) {
        out.push(piece);
        outSoft.push(i < pieces.length - 1);
      }
    }

    const split = Math.max(0, out.length - this.rows);
    this.scrollback = out.slice(0, split);
    this.#softBack = outSoft.slice(0, split);
    const visible = out.slice(split);
    const visibleSoft = outSoft.slice(split);
    this.screen = Array.from({ length: this.rows }, (_, y) => {
      const row = this.#blank();
      for (const [x, ch] of [...(visible[y] ?? "")].entries()) if (x < cols) row[x] = ch;
      return row;
    });
    this.#softScreen = Array.from({ length: this.rows }, (_, y) => visibleSoft[y] ?? false);
    this.r = Math.max(0, Math.min(this.rows - 1, cursorOut - split));
    this.c = Math.min(cursorCol, cols);
  }

  visible(): string[] {
    return this.screen.map((r) => r.join("").trimEnd());
  }
}

/**
 * A screen to assert against, wired to a stream the UI can be mounted on.
 *
 * The escape sequences a cell renderer emits *are* the row boundaries, so
 * stripping them concatenates the screen into one line. Every harness that
 * reads what is displayed has to play the output into a terminal instead.
 */
export function screen(cols: number, rows: number) {
  const term = new Term(cols, rows);
  let bytes = "";
  const stdout = Object.assign(
    new Writable({ write(c, _e, cb) { bytes += String(c); term.write(String(c)); cb(); return true; } }),
    { columns: cols, rows, isTTY: true },
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  return {
    term,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream & { write(s: string): void },
    /** Every row currently displayed, blank ones included. */
    lines: () => term.visible(),
    /** Everything written, scrollback first. */
    all: () => [...term.scrollback, ...term.visible()],
    /** The byte stream, for checks about terminal modes rather than content. */
    raw: () => bytes,
  };
}
