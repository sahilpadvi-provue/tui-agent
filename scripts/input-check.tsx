/**
 * Two things about input that no existing gate can see.
 *
 * Both were found by accident, which is the reason this exists.
 *
 * A run of printable characters is ONE event, not one per character. A handler
 * that rebuilds the line from its own state reads that state once per event,
 * so three events in a single chunk all compute from the same stale value and
 * only the last survives -- "abc" typed fast arrives as "c". Ink's parser
 * accumulates a text segment and pushes it whole (`input-parser.js:115-122`);
 * matching that is not a detail, it is the contract.
 *
 * And unmounting must not repaint. The tree empties on the way out, and
 * painting that erases the final frame -- which also makes every harness that
 * reads the screen after `unmount()` read a blank one.
 */

import React from "react";
import { Parser } from "../src/ui/render/input.ts";
import { Label, mount, useKeys } from "../src/ui/primitives.tsx";
import { screen } from "./vt.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const chars = (p: Parser, data: string) => p.push(data).events.map((e) => e.char);
const keysOn = (p: Parser, data: string) =>
  p.push(data).events.map((e) => Object.entries(e.key).filter(([, v]) => v).map(([k]) => k).join("+"));

// --- a run is one event ----------------------------------------------------

check("a run of printable characters is one event",
  JSON.stringify(chars(new Parser(), "abc")) === JSON.stringify(["abc"]),
  JSON.stringify(chars(new Parser(), "abc")));

check("a run is split only where a real key interrupts it",
  JSON.stringify(chars(new Parser(), "ab\rcd")) === JSON.stringify(["ab", "", "cd"]),
  JSON.stringify(chars(new Parser(), "ab\rcd")));

check("a control key still arrives alone",
  JSON.stringify(keysOn(new Parser(), "\x15")) === JSON.stringify(["ctrl"]));

// --- keys the composer binds ----------------------------------------------

const seq = (data: string) => keysOn(new Parser(), data).join(",");
check("arrows", seq("\x1b[D") === "leftArrow" && seq("\x1b[C") === "rightArrow");
check("home and end, both encodings",
  seq("\x1b[H") === "home" && seq("\x1b[F") === "end"
  && seq("\x1b[1~") === "home" && seq("\x1b[4~") === "end");
check("alt-arrow carries meta, so the word jumps work",
  seq("\x1b[1;3D") === "meta+leftArrow", seq("\x1b[1;3D"));
check("delete is not backspace", seq("\x1b[3~") === "delete" && seq("\x7f") === "backspace");

// --- a paste split across reads -------------------------------------------

const split = new Parser();
const first = split.push("\x1b[200~function add(a, b) {\nreturn a + b;");
check("a paste split across reads yields nothing yet",
  first.events.length === 0 && first.pastes.length === 0,
  `${first.events.length} event(s), ${first.pastes.length} paste(s)`);

const second = split.push("\n}\x1b[201~");
check("and arrives whole when the terminator lands",
  second.pastes.length === 1 && second.pastes[0] === "function add(a, b) {\nreturn a + b;\n}",
  JSON.stringify(second.pastes));

check("its newlines never became Enter", second.events.length === 0);

// --- line endings ---------------------------------------------------------
//
// Each delimiter style separately, because one passing says nothing about the
// others. LF worked while CRLF submitted every Windows paste at its first line
// break, and a single "a paste inserts newlines" assertion was green for it.

/** Enter, the newline key, or the text -- the three things the composer acts on. */
const acted = (p: Parser, data: string) =>
  p.push(data).events.map((e) =>
    e.key.return ? "enter" : e.key.ctrl && e.char === "j" ? "newline" : e.char || "?");
const one = (data: string) => acted(new Parser(), data).join(",");

check("LF is the newline key, not Enter", one("one\ntwo") === "one,newline,two", one("one\ntwo"));
check("CRLF is one newline, not Enter and then one",
  one("one\r\ntwo") === "one,newline,two", one("one\r\ntwo"));
// A CR with nothing after it cannot be told from Enter -- same byte, no
// lookahead left -- so a pre-OSX CR-only paste is not fixable here. Asserted
// as Enter so the limit is recorded rather than discovered.
check("a lone CR is Enter, which is what makes CR-only pastes unfixable",
  one("one\rtwo") === "one,enter,two", one("one\rtwo"));

check("a real Enter still submits", one("\r") === "enter", one("\r"));
check("two real Enters in one chunk are still two",
  one("\r\r") === "enter,enter", one("\r\r"));
check("Enter at the end of a run still submits", one("ab\r") === "ab,enter", one("ab\r"));

// The CR of a CRLF pair can land at the end of one read with its LF in the
// next. The CR has already gone out as Enter by then and cannot be recalled,
// so the LF is swallowed: the paste still submits early, but it does not also
// leave a stray newline in the prompt that follows.
const boundary = new Parser();
const beforeBreak = acted(boundary, "one\r").join(",");
const afterBreak = acted(boundary, "\ntwo").join(",");
check("a CRLF split across reads does not leave a stray newline behind",
  beforeBreak === "one,enter" && afterBreak === "two", `${beforeBreak} | ${afterBreak}`);

// And the swallow must not eat a real one. Enter, then typing, then a
// deliberate ctrl-j: only the LF immediately after the CR is ever dropped.
const typing = new Parser();
acted(typing, "ab\r");
check("and typing after an Enter is untouched", acted(typing, "cd").join(",") === "cd");
const later = new Parser();
acted(later, "ab\r");
acted(later, "cd");
check("a ctrl-j pressed later is still a newline",
  acted(later, "\n").join(",") === "newline", acted(later, "\n").join(","));

// --- unmounting leaves the frame ------------------------------------------

// Several rows, because a one-row frame does not reproduce it: unmount writes
// a newline of its own, which happens to push the erase below the only row.
const view = screen(40, 10);
const app = mount(
  <>
    <Label>row one</Label>
    <Label>row two</Label>
    <Label>still here</Label>
  </>,
  { stdout: view.stdout, stdin: view.stdin },
);
await new Promise((r) => setTimeout(r, 80));
const before = view.lines().filter(Boolean).join("\n");
app.unmount();
await new Promise((r) => setTimeout(r, 80));
const after = view.lines().filter(Boolean).join("\n");

check("the frame is on screen before unmounting", before.includes("still here"));
check("and survives it", after.includes("still here"), JSON.stringify(after));



// --- a codepoint split across two reads -------------------------------------
//
// `String(buffer)` decodes each chunk alone, so a multi-byte character landing
// on a read boundary became two replacement characters. The split has to be
// deliberate: writing the whole word in one chunk passes on the broken build
// and proves nothing.

async function typed(word: string, cut: number): Promise<string> {
  const v = screen(40, 8);
  const got: string[] = [];
  function Probe() {
    useKeys((ch) => {
      if (ch) got.push(ch);
    });
    return <Label>probe</Label>;
  }
  const a = mount(<Probe />, { stdout: v.stdout, stdin: v.stdin });
  await new Promise((r) => setTimeout(r, 60));
  const bytes = Buffer.from(word, "utf8");
  (v.stdin as unknown as { write(b: Buffer): void }).write(bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 30));
  (v.stdin as unknown as { write(b: Buffer): void }).write(bytes.subarray(cut));
  await new Promise((r) => setTimeout(r, 60));
  a.unmount();
  return got.join("");
}

const latin = await typed("café", Buffer.from("café", "utf8").length - 1);
check("a two-byte character split across reads survives", latin === "café", JSON.stringify(latin));

const cjk = await typed("日本語", 4);
check("and a three-byte one", cjk === "日本語", JSON.stringify(cjk));

const emoji = await typed("ok 🚀", 5);
check("and a surrogate pair", emoji === "ok 🚀", JSON.stringify(emoji));

check("no replacement character reached the handler",
  ![latin, cjk, emoji].some((s) => s.includes("�")),
  "a replacement character is corrupted input, not a rendering problem");

process.exit(failures === 0 ? 0 : 1);
