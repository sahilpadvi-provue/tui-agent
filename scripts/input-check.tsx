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
import { Label, mount } from "../src/ui/render/primitives.tsx";
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

process.exit(failures === 0 ? 0 : 1);
