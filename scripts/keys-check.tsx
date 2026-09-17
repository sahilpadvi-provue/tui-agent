/**
 * The composer is a line editor, and a line editor is judged on one thing:
 * the text that comes out of it.
 *
 * So every movement is probed by what it lets you type next, and every
 * deletion by what is left, rather than by finding the cursor in the frame.
 * A cursor read off the rendered row would pass on a build that draws it in
 * the right place and edits in the wrong one.
 */
import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ws = mkdtempSync(join(tmpdir(), "keys-"));

const LEFT = "\x1b[D", RIGHT = "\x1b[C", UP = "\x1b[A", DOWN = "\x1b[B";
const ALT_LEFT = "\x1b[1;3D", ALT_RIGHT = "\x1b[1;3C";
const HOME = "\x1b[H", END = "\x1b[F", DEL = "\x1b[3~", BS = "\x7f", ESC = "\x1b";
const CTRL = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);
const ENTER = "\r";

async function drive(keys: string[], width = 100) {
  let out = "";
  const sent: string[] = [];
  const ran: string[] = [];
  const so = Object.assign(new Writable({ write(c, _e, cb) { out += String(c); cb(); return true; } }),
    { columns: width, rows: 40, isTTY: true });
  const si = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(
    <App bus={new EventBus()} cwd={ws} model="m" version="0" backend="b" sandbox="off" busy={false}
         onSubmit={(t) => sent.push(t)} onCommand={(c) => ran.push(c)} onCancel={() => {}} onPermission={() => {}} />,
    { stdout: so as any, stdin: si as any, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 110));
  for (const k of keys) { si.write(k); await new Promise((r) => setTimeout(r, 45)); }
  await new Promise((r) => setTimeout(r, 120));
  app.unmount();
  await app.waitUntilExit();
  const frames = out.split("\x1b[?2026h");
  const frame = (frames[frames.length - 1] ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  return { sent, ran, frame, raw: out };
}

/** What the composer held, read back through the one path that reveals it. */
const typed = async (keys: string[]) => (await drive([...keys, ENTER])).sent.join("|");

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

check("left arrow inserts before the last character", await typed(["abc", LEFT, "X"]) === "abXc");
check("right arrow comes back", await typed(["abc", LEFT, LEFT, RIGHT, "X"]) === "abXc");
check("the cursor stops at the start", await typed(["ab", LEFT, LEFT, LEFT, LEFT, "X"]) === "Xab");
check("and at the end", await typed(["ab", RIGHT, RIGHT, "X"]) === "abX");

check("ctrl-a goes to the start", await typed(["abc", CTRL("a"), "X"]) === "Xabc");
check("ctrl-e goes back to the end", await typed(["abc", CTRL("a"), CTRL("e"), "X"]) === "abcX");
check("home and end do the same", await typed(["abc", HOME, "X", END, "Y"]) === "Xabc" + "Y");

check("alt-left moves a word", await typed(["one two three", ALT_LEFT, "X"]) === "one two Xthree");
check("alt-left again crosses the space", await typed(["one two three", ALT_LEFT, ALT_LEFT, "X"]) === "one Xtwo three");
check("alt-right moves a word", await typed(["one two", HOME, ALT_RIGHT, "X"]) === "oneX two");
check("alt-b and alt-f are the same movements",
  await typed(["one two", "\x1bb", "X"]) === "one Xtwo" && await typed(["one two", HOME, "\x1bf", "X"]) === "oneX two");

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

check("backspace deletes before the cursor", await typed(["abc", LEFT, BS, "X"]) === "aXc");
check("backspace at the start does nothing", await typed(["abc", HOME, BS, "X"]) === "Xabc");
check("delete removes the character under the cursor", await typed(["abc", LEFT, DEL, "X"]) === "abX");
check("delete at the end does nothing", await typed(["abc", DEL, "X"]) === "abcX");

check("ctrl-w deletes the word behind", await typed(["one two three", CTRL("w"), "X"]) === "one two X");
check("ctrl-w works mid-line", await typed(["one two three", ALT_LEFT, CTRL("w"), "X"]) === "one Xthree");
check("ctrl-u deletes back to the start", await typed(["one two", LEFT, CTRL("u"), "X"]) === "Xo");
check("ctrl-k deletes to the end", await typed(["one two", HOME, ALT_RIGHT, CTRL("k"), "X"]) === "oneX");

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

check("up recalls the last thing sent",
  (await drive(["first", ENTER, "second", ENTER, UP, ENTER])).sent.join("|") === "first|second|second");
check("up twice reaches the one before",
  (await drive(["first", ENTER, "second", ENTER, UP, UP, ENTER])).sent.join("|") === "first|second|first");
check("down comes forward again",
  (await drive(["first", ENTER, "second", ENTER, UP, UP, DOWN, ENTER])).sent.join("|") === "first|second|second");
check("ctrl-p and ctrl-n are the same movements",
  (await drive(["first", ENTER, "second", ENTER, CTRL("p"), CTRL("p"), CTRL("n"), ENTER])).sent.join("|")
    === "first|second|second");
check("a recalled line can be edited",
  (await drive(["hello", ENTER, UP, "!", ENTER])).sent.join("|") === "hello|hello!");
check("the half-written line survives a look at history",
  (await drive(["done", ENTER, "half", UP, DOWN, ENTER])).sent.join("|") === "done|half");
check("up on an empty history does nothing", (await drive([UP, "x", ENTER])).sent.join("|") === "x");
check("commands go into history too",
  (await drive(["/help", ENTER, UP, ENTER])).ran.join("|") === "/help|/help");

// ---------------------------------------------------------------------------
// The list, and the shortcut panel
// ---------------------------------------------------------------------------

check("esc closes the command list", !(await drive(["/", ESC])).frame.includes("list these commands"));
check("typing opens it again", (await drive(["/", ESC, "h"])).frame.includes("list these commands"));
check("a closed list gives the arrows back to history",
  (await drive(["hello", ENTER, "/", ESC, CTRL("u"), UP, ENTER])).sent.join("|") === "hello|hello");

const panel = await drive(["?"]);
check("? on an empty prompt lists the bindings", panel.frame.includes("any key to dismiss"));
check("the next key dismisses it", !(await drive(["?", "x"])).frame.includes("any key to dismiss"));
check("? after some text is just a character", await typed(["why", "?"]) === "why?");

// ---------------------------------------------------------------------------
// Paste
//
// A terminal in raw mode sends CR for a pasted line break -- the same byte as
// Enter. Bracketed paste is the only thing that tells them apart, and the case
// that exposes its absence is a read boundary landing exactly on a break.
//
// A multi-line paste then becomes one character in the prompt, drawn as a
// label. Everything below is really one claim: that character behaves like a
// character, and expands to the payload only on the way out.
// ---------------------------------------------------------------------------

const CODE = "function add(a, b) {\r  return a + b;\r}";
const BODY = "function add(a, b) {\n  return a + b;\n}";
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;
const CHIP = "[Pasted text #1 +3 lines]";

// Without this the terminal never brackets a paste, every pasted line break
// is the same byte as Enter, and the rest of these checks are only testing
// that the parser understands markers nothing is asking it to send.
check("the terminal is put into bracketed paste mode",
  (await drive([])).raw.includes("\x1b[?2004h"));

const one = await drive([PASTE(CODE)]);
check("a pasted block collapses to one chip", one.frame.includes(CHIP), one.frame.slice(-200));
check("it takes a single row",
  one.frame.split("\n").filter((l) => l.includes("Pasted text")).length === 1);

check("the chip expands on the way out", (await drive([PASTE(CODE), ENTER])).sent[0] === BODY,
  JSON.stringify((await drive([PASTE(CODE), ENTER])).sent[0]));

// The regression: delivered as separate writes, one of which is a lone CR.
const split = await drive(["\x1b[200~function add(a, b) {", "\r", "  return a + b;", "\r", "}\x1b[201~", ENTER]);
check("a paste split across reads does not submit itself", split.sent.length === 1, JSON.stringify(split.sent));
check("and loses nothing", split.sent[0] === BODY, JSON.stringify(split.sent[0]));

check("a pasted line break is never a submit on its own",
  (await drive([PASTE("only one line")])).sent.length === 0);
check("a single-line paste stays literal",
  !(await drive([PASTE("just a path")])).frame.includes("Pasted text"));

check("you can type around a chip",
  (await drive(["look: ", PASTE(CODE), " what is wrong?", ENTER])).sent[0]
    === `look: ${BODY} what is wrong?`);

// The reason a chip is one codepoint rather than a label in the string.
check("backspace deletes the whole chip",
  (await drive([PASTE(CODE), BS, "x", ENTER])).sent[0] === "x",
  JSON.stringify((await drive([PASTE(CODE), BS, "x", ENTER])).sent[0]));
check("ctrl-w deletes the whole chip",
  (await drive([PASTE(CODE), CTRL("w"), "x", ENTER])).sent[0] === "x");
check("one left arrow steps over the whole chip",
  (await drive([PASTE(CODE), LEFT, "x", ENTER])).sent[0] === `x${BODY}`);
check("and one right arrow comes back over it",
  (await drive([PASTE(CODE), LEFT, RIGHT, "x", ENTER])).sent[0] === `${BODY}x`);
check("delete removes the chip the cursor is on",
  (await drive([PASTE(CODE), LEFT, DEL, "x", ENTER])).sent[0] === "x");

const two = await drive([PASTE("a\rb"), " and ", PASTE("c\rd\re")]);
check("chips are numbered in the order they arrive",
  two.frame.includes("[Pasted text #1 +2 lines]") && two.frame.includes("[Pasted text #2 +3 lines]"),
  two.frame.slice(-200));
check("both expand", (await drive([PASTE("a\rb"), " and ", PASTE("c\rd\re"), ENTER])).sent[0]
  === "a\nb and c\nd\ne");

const recalled = await drive([PASTE(CODE), ENTER, UP, ENTER]);
check("a recalled line keeps the chip and still expands",
  recalled.sent.length === 2 && recalled.sent[1] === BODY, JSON.stringify(recalled.sent[1]));

const huge = PASTE(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\r"));
const big = await drive([huge]);
check("size does not change what it costs on screen",
  big.frame.includes("[Pasted text #1 +400 lines]")
    && big.frame.split("\n").filter((l) => l.includes("Pasted text")).length === 1);

console.log(failures === 0 ? "\nall key bindings behave" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
