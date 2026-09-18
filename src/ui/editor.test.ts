/**
 * Unit tests for the composer's pure helpers.
 *
 * These complement the gate scripts, they do not replace them: the gates prove
 * a binding edits what it claims to through the real App, and these pin the
 * functions underneath so a regression is caught at the unit that caused it
 * rather than only at the screen. Every case here is one the composer can hit.
 */
import { test, expect, describe } from "bun:test";
import {
  wordLeft, wordRight, normalizeNewlines,
  pasteMark, isPasteMark, pasteId, expandPastes, composerPieces,
  composerRows, rowUp, rowDown,
} from "./editor.ts";

describe("wordLeft", () => {
  test("stops at the start of the current word", () => {
    expect(wordLeft("one two three", 13)).toBe(8);
  });
  test("crosses trailing whitespace first", () => {
    expect(wordLeft("one two   ", 10)).toBe(4);
  });
  test("mid-word lands at that word's start", () => {
    expect(wordLeft("alpha beta", 8)).toBe(6);
  });
  test("at the very start is a no-op", () => {
    expect(wordLeft("abc", 0)).toBe(0);
  });
  test("clamps an out-of-range cursor", () => {
    expect(wordLeft("abc", 99)).toBe(0);
    expect(wordLeft("abc", -5)).toBe(0);
  });
  test("empty string stays at zero", () => {
    expect(wordLeft("", 0)).toBe(0);
  });
});

describe("wordRight", () => {
  test("stops at the end of the current word", () => {
    expect(wordRight("one two three", 0)).toBe(3);
  });
  test("crosses leading whitespace first", () => {
    expect(wordRight("one   two", 3)).toBe(9);
  });
  test("at the very end is a no-op", () => {
    expect(wordRight("abc", 3)).toBe(3);
  });
  test("clamps an out-of-range cursor", () => {
    expect(wordRight("abc", 99)).toBe(3);
    expect(wordRight("abc", -5)).toBe(3);
  });
  test("a path is one word, not split at the slashes", () => {
    // The reason words are whitespace-delimited: the composer holds paths.
    expect(wordRight("/src/ui/app.tsx next", 0)).toBe(15);
  });
});

describe("normalizeNewlines", () => {
  test("CRLF becomes LF", () => {
    expect(normalizeNewlines("a\r\nb")).toBe("a\nb");
  });
  test("a lone CR becomes LF", () => {
    expect(normalizeNewlines("a\rb")).toBe("a\nb");
  });
  test("an existing LF is untouched", () => {
    expect(normalizeNewlines("a\nb")).toBe("a\nb");
  });
  test("CRLF then CR is two line breaks, not one", () => {
    expect(normalizeNewlines("a\r\n\rb")).toBe("a\n\nb");
  });
  test("text with no breaks is returned as is", () => {
    expect(normalizeNewlines("plain text")).toBe("plain text");
  });
});

describe("paste marks", () => {
  test("mark, isPasteMark and id round-trip", () => {
    const m = pasteMark(0);
    expect(isPasteMark(m)).toBe(true);
    expect(pasteId(m)).toBe(1);
  });
  test("ids count from one, in arrival order", () => {
    expect(pasteId(pasteMark(0))).toBe(1);
    expect(pasteId(pasteMark(4))).toBe(5);
  });
  test("an ordinary character is not a mark", () => {
    expect(isPasteMark("a")).toBe(false);
    expect(isPasteMark("/")).toBe(false);
    expect(isPasteMark("")).toBe(false);
  });
  test("the id space wraps rather than escaping its block", () => {
    expect(pasteMark(4096)).toBe(pasteMark(0));
    expect(isPasteMark(pasteMark(4096))).toBe(true);
  });
});

describe("expandPastes", () => {
  test("a mark expands to its payload, newlines and all", () => {
    const m = pasteMark(0);
    const pastes = new Map([[m, "line one\nline two"]]);
    expect(expandPastes(`before ${m} after`, pastes)).toBe("before line one\nline two after");
  });
  test("ordinary text is untouched", () => {
    expect(expandPastes("nothing here", new Map())).toBe("nothing here");
  });
  test("a mark with no payload is left as the character", () => {
    const m = pasteMark(0);
    expect(expandPastes(`x${m}y`, new Map())).toBe(`x${m}y`);
  });
  test("two marks expand independently", () => {
    const a = pasteMark(0);
    const b = pasteMark(1);
    const pastes = new Map([[a, "AA"], [b, "BB"]]);
    expect(expandPastes(`${a} and ${b}`, pastes)).toBe("AA and BB");
  });
});

describe("composerPieces", () => {
  const label = () => "[chip]";

  test("plain text splits around the cursor", () => {
    expect(composerPieces("abc", 1, label)).toEqual([
      { text: "a", paste: false, cursor: false },
      { text: "b", paste: false, cursor: true },
      { text: "c", paste: false, cursor: false },
    ]);
  });
  test("a cursor at the end produces no cursor piece", () => {
    // The bar at end-of-line is drawn by App, not by a piece.
    const pieces = composerPieces("ab", 2, label);
    expect(pieces).toEqual([{ text: "ab", paste: false, cursor: false }]);
  });
  test("a mark becomes one labelled piece", () => {
    const m = pasteMark(0);
    const pieces = composerPieces(`x${m}y`, 0, label);
    expect(pieces).toEqual([
      { text: "x", paste: false, cursor: true },
      { text: "[chip]", paste: true, cursor: false },
      { text: "y", paste: false, cursor: false },
    ]);
  });
  test("the cursor can sit on the chip", () => {
    const m = pasteMark(0);
    const pieces = composerPieces(`x${m}y`, 1, label);
    expect(pieces[1]).toEqual({ text: "[chip]", paste: true, cursor: true });
  });
  test("empty input is no pieces", () => {
    expect(composerPieces("", 0, label)).toEqual([]);
  });
});

const label = (_: string) => "[chip]";

describe("composerRows", () => {
  test("a prompt with no newline is one row", () => {
    const rows = composerRows("abc", 3, label);
    expect(rows.length).toBe(1);
    expect(rows[0]!.caret).toBe(true);
  });
  test("a newline splits the rows and the marker row keeps its text", () => {
    const rows = composerRows("ab\ncd", 5, label);
    expect(rows.length).toBe(2);
    expect(rows[0]!.pieces.map((p) => p.text).join("")).toBe("ab");
    expect(rows[1]!.pieces.map((p) => p.text).join("")).toBe("cd");
  });
  test("the caret is on the row the cursor is in, and nowhere else", () => {
    const rows = composerRows("ab\ncd", 5, label);
    expect(rows.map((r) => r.caret)).toEqual([false, true]);
  });
  test("a cursor resting on the newline draws at the end of the row before it", () => {
    const rows = composerRows("ab\ncd", 2, label);
    expect(rows.map((r) => r.caret)).toEqual([true, false]);
  });
  test("a cursor inside a row marks a piece rather than the caret", () => {
    const rows = composerRows("ab\ncd", 4, label);
    expect(rows[1]!.pieces.some((p) => p.cursor)).toBe(true);
    expect(rows[1]!.caret).toBe(false);
  });
  test("an empty prompt is still one row, with the caret", () => {
    expect(composerRows("", 0, label)).toEqual([{ pieces: [], caret: true }]);
  });
  test("a trailing newline leaves an empty last row", () => {
    const rows = composerRows("ab\n", 3, label);
    expect(rows.length).toBe(2);
    expect(rows[1]!.pieces).toEqual([]);
    expect(rows[1]!.caret).toBe(true);
  });
});

describe("rowUp and rowDown", () => {
  test("decline on a single-row prompt, so history keeps the arrows", () => {
    expect(rowUp("abc", 1)).toBeNull();
    expect(rowDown("abc", 1)).toBeNull();
  });
  test("decline at the first and last row of a multi-row prompt", () => {
    expect(rowUp("ab\ncd", 1)).toBeNull();
    expect(rowDown("ab\ncd", 4)).toBeNull();
  });
  test("up keeps the column", () => {
    expect(rowUp("abcd\nefgh", 7)).toBe(2);
  });
  test("down keeps the column", () => {
    expect(rowDown("abcd\nefgh", 2)).toBe(7);
  });
  test("a shorter target row clamps to its end rather than overshooting", () => {
    expect(rowUp("ab\ncdef", 7)).toBe(2);
  });
  test("the end of a row is reachable from the row below", () => {
    expect(rowUp("ab\ncd", 5)).toBe(2);
  });
  test("three rows step one at a time", () => {
    expect(rowUp("a\nb\nc", 4)).toBe(2);
    expect(rowUp("a\nb\nc", 2)).toBe(0);
    expect(rowUp("a\nb\nc", 0)).toBeNull();
  });
  test("an out-of-range cursor is clamped, not trusted", () => {
    expect(rowUp("ab\ncd", 99)).toBe(2);
    expect(rowDown("ab\ncd", -5)).toBe(3);
  });
});
