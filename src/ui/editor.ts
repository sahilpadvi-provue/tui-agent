/**
 * Where the cursor lands, for the movements that skip more than one character.
 *
 * Words are whitespace-delimited, which is the readline convention and the one
 * a person's fingers already know from their shell. A punctuation-aware
 * version is what an editor would do and is wrong here: the composer holds
 * prose and paths, and `src/ui/app.tsx` should stop at the path, not inside it.
 */

/** Start of the word at or before `at`. Leading whitespace is crossed first. */
export function wordLeft(text: string, at: number): number {
  let i = Math.max(0, Math.min(text.length, at));
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

/** End of the word at or after `at`. */
export function wordRight(text: string, at: number): number {
  let i = Math.max(0, Math.min(text.length, at));
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  return i;
}

/**
 * Line breaks as the rest of the program expects them.
 *
 * A terminal in raw mode delivers a pasted line break as CR, so pasted text
 * arrives full of `\r`. Those render as nothing -- a pasted function shows up
 * as one run-on line -- and reach the model as a character it does not expect.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export type ComposerRow =
  | { kind: "text"; text: string; cursor?: number }
  | { kind: "hidden"; count: number };

/**
 * The prompt, as rows, with the middle of a long paste folded away.
 *
 * Sixty pasted lines are sixty rows of a region that is redrawn on every
 * keystroke, and the useful part of a paste is almost never its middle: it is
 * the first line, to recognise what was pasted, and whatever is being typed
 * now. So everything else collapses to a count.
 *
 * The line holding the cursor is always kept, which is what lets every
 * movement binding keep working inside a folded paste. `max` bounds the
 * unfolded case; a folded one is five rows whatever the paste's size.
 */
export function composerRows(text: string, cursor: number, max: number): ComposerRow[] {
  const lines = text.split("\n");

  let offset = Math.max(0, Math.min(text.length, cursor));
  let line = 0;
  while (line < lines.length - 1 && offset > lines[line]!.length) {
    offset -= lines[line]!.length + 1;
    line++;
  }

  const row = (i: number): ComposerRow =>
    i === line ? { kind: "text", text: lines[i]!, cursor: offset } : { kind: "text", text: lines[i]! };

  if (lines.length <= max) return lines.map((_, i) => row(i));

  const kept = [...new Set([0, line, lines.length - 1])].sort((a, b) => a - b);
  const rows: ComposerRow[] = [];
  let prev = -1;
  for (const i of kept) {
    if (i - prev > 1) rows.push({ kind: "hidden", count: i - prev - 1 });
    rows.push(row(i));
    prev = i;
  }
  return rows;
}
