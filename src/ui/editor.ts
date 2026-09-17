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

