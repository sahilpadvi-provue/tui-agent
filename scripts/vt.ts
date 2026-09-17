/**
 * A terminal, small enough to assert against.
 *
 * Ghosting is a terminal effect: a line wider than the new width becomes two
 * rows, so a renderer that erases by line count leaves the surplus behind.
 * Proving anything about it needs something that holds rows, scrolls, and
 * re-wraps on resize the way a real terminal does.
 */

export class Term {
  cols: number;
  rows: number;
  scrollback: string[] = [];
  screen: string[][];
  r = 0;
  c = 0;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(" "));
  }

  #blank(): string[] {
    return Array(this.cols).fill(" ");
  }

  #scroll(): void {
    this.scrollback.push((this.screen.shift() ?? []).join("").trimEnd());
    this.screen.push(this.#blank());
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
      if (this.c >= this.cols) { this.c = 0; this.#newline(); }
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
    for (let y = this.r + 1; y < this.rows; y++) this.screen[y] = this.#blank();
  }

  /** What a real terminal does on a narrow: re-wrap every line it is holding. */
  resize(cols: number): void {
    const logical = [...this.scrollback, ...this.screen.map((r) => r.join("").trimEnd())];
    const wrapped: string[] = [];
    for (const line of logical) {
      if (line === "") { wrapped.push(""); continue; }
      for (let i = 0; i < line.length; i += cols) wrapped.push(line.slice(i, i + cols));
    }
    this.cols = cols;
    const visible = wrapped.slice(-this.rows);
    this.scrollback = wrapped.slice(0, Math.max(0, wrapped.length - this.rows));
    this.screen = Array.from({ length: this.rows }, (_, y) => {
      const row = this.#blank();
      for (const [x, ch] of [...(visible[y] ?? "")].entries()) if (x < cols) row[x] = ch;
      return row;
    });
    this.r = Math.min(this.r, this.rows - 1);
  }

  visible(): string[] {
    return this.screen.map((r) => r.join("").trimEnd());
  }
}
