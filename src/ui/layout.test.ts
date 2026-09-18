/**
 * Unit tests for the layout system's pure functions.
 *
 * The spacing and wrapping rules are the kind of thing that looks right in one
 * terminal and wrong in another, so they are pinned here at the unit. The
 * rendering itself stays covered by the UI gates; this is the arithmetic under
 * it.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  measureAt, wrap, clip, outputLines, summariseCall, verbFor,
  shortenPath, shimmer, highlightCommand,
} from "./layout.ts";

describe("measureAt", () => {
  test("caps at the measure however wide the terminal", () => {
    expect(measureAt(0, 100)).toBe(88);
    expect(measureAt(0, 1000)).toBe(88);
  });
  test("follows a narrow terminal below the measure", () => {
    expect(measureAt(0, 50)).toBe(46); // 50 - GUTTER*2
  });
  test("never goes below the floor", () => {
    expect(measureAt(0, 10)).toBe(20);
  });
  test("depth eats into the available width", () => {
    expect(measureAt(1, 30)).toBe(24); // 30 - 4 - 2
    expect(measureAt(2, 30)).toBe(22); // 30 - 4 - 4
  });
});

describe("wrap", () => {
  test("a short line is returned whole", () => {
    expect(wrap("hello world", 80)).toEqual(["hello world"]);
  });
  test("a long line breaks on word boundaries", () => {
    expect(wrap("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
  });
  test("a run of blank lines collapses to one", () => {
    expect(wrap("a\n\n\nb", 80)).toEqual(["a", "", "b"]);
  });
  test("leading and trailing blanks are dropped", () => {
    expect(wrap("\n\na\n\n", 80)).toEqual(["a"]);
  });
  test("a single paragraph break survives", () => {
    expect(wrap("para one\n\npara two", 80)).toEqual(["para one", "", "para two"]);
  });
  test("trailing whitespace on a line is trimmed", () => {
    expect(wrap("hello     ", 80)).toEqual(["hello"]);
  });
});

describe("clip", () => {
  test("shorter than the width is unchanged", () => {
    expect(clip("abc", 10)).toBe("abc");
  });
  test("longer is truncated with an ellipsis to exactly the width", () => {
    const out = clip("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });
  test("tabs become two spaces and newlines become one", () => {
    expect(clip("a\tb\nc", 20)).toBe("a  b c");
  });
});

describe("outputLines", () => {
  test("at or under the limit-plus-one, everything shows", () => {
    const body = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");
    const { lines, hidden } = outputLines(body); // default limit 8
    expect(lines.length).toBe(9);
    expect(hidden).toBe(0);
  });
  test("over that, it caps and reports the remainder", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const { lines, hidden } = outputLines(body);
    expect(lines.length).toBe(8);
    expect(hidden).toBe(2);
  });
  test("blank lines are not counted", () => {
    expect(outputLines("a\n\n\nb")).toEqual({ lines: ["a", "b"], hidden: 0 });
  });
});

describe("summariseCall", () => {
  test("shell shows the command", () => {
    expect(summariseCall("shell", { command: "npm test" })).toBe("npm test");
  });
  test("a file tool shows the path", () => {
    expect(summariseCall("read_file", { path: "a.ts" })).toBe("a.ts");
  });
  test("replace_lines shows a single line without a range", () => {
    expect(summariseCall("replace_lines", { path: "a.ts", start_line: 3, end_line: 3 })).toBe("a.ts:3");
  });
  test("replace_lines shows a range when the lines differ", () => {
    expect(summariseCall("replace_lines", { path: "a.ts", start_line: 3, end_line: 5 })).toBe("a.ts:3-5");
  });
  test("replace_lines without line numbers falls back to the path", () => {
    expect(summariseCall("replace_lines", { path: "a.ts" })).toBe("a.ts");
  });
  test("search names where it looked, unless that is the root", () => {
    expect(summariseCall("search", { pattern: "foo", path: "src" })).toBe("foo  in src");
    expect(summariseCall("search", { pattern: "foo", path: "." })).toBe("foo");
    expect(summariseCall("search", { pattern: "foo" })).toBe("foo");
  });
  test("list_files defaults to the root", () => {
    expect(summariseCall("list_files", {})).toBe(".");
  });
  test("an unknown tool shows its args, or nothing when empty", () => {
    expect(summariseCall("mystery", { a: 1 })).toBe('{"a":1}');
    expect(summariseCall("mystery", {})).toBe("");
  });
});

describe("verbFor", () => {
  test("known tools get their verb", () => {
    expect(verbFor("shell")).toBe("Ran");
    expect(verbFor("replace_lines")).toBe("Edited");
  });
  test("an unknown tool is its own name", () => {
    expect(verbFor("mystery")).toBe("mystery");
  });
});

describe("shortenPath", () => {
  const realHome = process.env.HOME;
  afterEach(() => { process.env.HOME = realHome; });

  test("a path that fits is unchanged", () => {
    expect(shortenPath("/a/b", 20)).toBe("/a/b");
  });
  test("a long path is cut from the left to exactly the width", () => {
    const out = shortenPath("/a/b/c/d/e/f", 8);
    expect(out.startsWith("…")).toBe(true);
    expect(out.length).toBe(8);
    expect(out.endsWith("/e/f")).toBe(true);
  });
  test("a path under HOME is shown with a tilde once it must be shortened", () => {
    // The tilde form is only reached when the full path does not fit; at width
    // 16 the raw path (20) does not but "~/projects/app" (14) does.
    process.env.HOME = "/home/u";
    expect(shortenPath("/home/u/projects/app", 16)).toBe("~/projects/app");
  });
});

describe("shimmer", () => {
  test("one span per character", () => {
    expect(shimmer("abc", 0)).toHaveLength(3);
  });
  test("the head character is the brightest", () => {
    expect(shimmer("abc", 0)[0]?.color).toBe("#ffffff");
  });
  test("characters keep their order and text", () => {
    expect(shimmer("hi", 0).map((s) => s.text)).toEqual(["h", "i"]);
  });
});

describe("highlightCommand", () => {
  const text = (cmd: string) => highlightCommand(cmd).map((s) => s.text).join("");

  test("the reconstructed text is exactly the input", () => {
    for (const cmd of ["npm test", "ls -la  src/", "cat a | grep b"]) {
      expect(text(cmd)).toBe(cmd);
    }
  });
  test("the binary is tinted, once", () => {
    const spans = highlightCommand("npm test");
    expect(spans[0]).toEqual({ text: "npm", color: "cyan" });
  });
  test("flags and paths are tinted differently", () => {
    const spans = highlightCommand("ls -la src/x");
    expect(spans.find((s) => s.text === "-la")?.color).toBe("yellow");
    expect(spans.find((s) => s.text === "src/x")?.dim).toBe(true);
  });
});
