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

/**
 * A pasted block is one character.
 *
 * It is drawn as `[Pasted text #1 +13 lines]`, but in the prompt string it
 * occupies a single private-use codepoint. That is the whole trick: backspace
 * deletes it whole, the arrows step over it and ctrl-w takes it as a word,
 * all without a rule anywhere, because there is no multi-character token to
 * leave half of. A label kept in the string instead would have to be defended
 * by every editing binding, and the cost of missing one is silent -- a broken
 * label stops matching its payload and the prompt submits the label text.
 */
const PASTE_BASE = 0xe000;
const PASTE_LIMIT = 0x1000;

export function pasteMark(id: number): string {
  return String.fromCodePoint(PASTE_BASE + (id % PASTE_LIMIT));
}

export function isPasteMark(ch: string): boolean {
  const code = ch.codePointAt(0);
  return code !== undefined && code >= PASTE_BASE && code < PASTE_BASE + PASTE_LIMIT;
}

/** Which paste this is, counting from one, for the label. */
export function pasteId(mark: string): number {
  return (mark.codePointAt(0) ?? PASTE_BASE) - PASTE_BASE + 1;
}

/** The prompt as it goes to the model: every mark back to what was pasted. */
export function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  return [...text].map((ch) => pastes.get(ch) ?? ch).join("");
}

export type Piece = { text: string; paste: boolean; cursor: boolean };

/**
 * The prompt as it is drawn: runs of ordinary text, the pasted blocks as their
 * labels, and whichever one the cursor is sitting on.
 */
export function composerPieces(text: string, cursor: number, label: (mark: string) => string): Piece[] {
  const pieces: Piece[] = [];
  let run = "";
  const flush = () => {
    if (run) pieces.push({ text: run, paste: false, cursor: false });
    run = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (isPasteMark(ch)) {
      flush();
      pieces.push({ text: label(ch), paste: true, cursor: i === cursor });
    } else if (i === cursor) {
      flush();
      pieces.push({ text: ch, paste: false, cursor: true });
    } else {
      run += ch;
    }
  }
  flush();
  return pieces;
}
