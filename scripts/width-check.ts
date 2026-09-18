/**
 * Width is columns on a terminal, not code units in a string.
 *
 * `.length` was wrong in both directions and both directions reached the
 * screen. `clip` sliced by code unit, so truncating next to an emoji put an
 * orphaned high surrogate on the wire -- a broken byte, not a cosmetic slip.
 * And `wrap` measured a line of Japanese at half its width, so it passed
 * through unwrapped and overflowed the band it was supposed to fit inside.
 *
 * It arrives through tool arguments, tool output, queued rows, palette
 * summaries and the session title in the footer, so there is no path where
 * only ASCII can appear.
 */
import { clip, wrap, displayWidth, charWidth, sliceToWidth, type Line } from "../src/ui/layout.ts";
import { paint, cellAt } from "../src/ui/render/screen.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ROCKET = "\u{1F680}";
const JP = "これは日本語";      // 6 chars, 12 columns
const COMBINING = "é";                             // e + acute, 1 column

const lone = (s: string) =>
  [...s].some((c) => {
    const n = c.codePointAt(0)!;
    return n >= 0xd800 && n <= 0xdfff;
  });

// ---- measuring -------------------------------------------------------------

check("an emoji is two columns", charWidth(0x1f680) === 2);
check("a CJK ideograph is two columns", charWidth(0x65e5) === 2);
check("a combining mark is none", charWidth(0x0301) === 0);
check("ASCII is one", charWidth(0x41) === 1 && charWidth(0x20) === 1);
check("displayWidth counts columns, not units",
  displayWidth(JP) === 12 && displayWidth(ROCKET) === 2 && displayWidth(COMBINING) === 1,
  `${displayWidth(JP)} ${displayWidth(ROCKET)} ${displayWidth(COMBINING)}`);
check("and .length would have been wrong for all three",
  JP.length === 6 && ROCKET.length === 2 && COMBINING.length === 2);

check("sliceToWidth stops before a glyph it cannot fit",
  sliceToWidth(`ab${ROCKET}`, 3) === "ab" && sliceToWidth(`ab${ROCKET}`, 4) === `ab${ROCKET}`,
  JSON.stringify([sliceToWidth(`ab${ROCKET}`, 3), sliceToWidth(`ab${ROCKET}`, 4)]));
check("and never ends inside a surrogate pair",
  !lone(sliceToWidth(`ab${ROCKET}cd`, 3)));

// ---- clip ------------------------------------------------------------------

const clipped = clip(`deploy the ${ROCKET} rocket`, 13);
check("clip does not emit a lone surrogate", !lone(clipped), JSON.stringify(clipped));
check("and stays within its budget", displayWidth(clipped) <= 13, `${displayWidth(clipped)}`);
check("clip leaves a string that already fits alone", clip("short", 20) === "short");
check("clip measures CJK in columns",
  displayWidth(clip(JP.repeat(4), 10)) <= 10, JSON.stringify(clip(JP.repeat(4), 10)));

// ---- wrap ------------------------------------------------------------------

const jpWrapped = wrap(JP.repeat(8), 24);
check("wrap breaks CJK to fit the measure",
  jpWrapped.every((r) => displayWidth(r) <= 24),
  JSON.stringify(jpWrapped.map(displayWidth)));
check("and loses nothing doing it", jpWrapped.join("") === JP.repeat(8));

// A word that fits is still never broken: that is the behaviour prose needs,
// and only a word too wide for a line of its own is split.
check("a long word that fits a line is left whole",
  JSON.stringify(wrap("https://example.com/a/very/long/path", 40))
    === JSON.stringify(["https://example.com/a/very/long/path"]));
check("a word too wide for any line is broken rather than overflowing",
  wrap("x".repeat(30), 10).every((r) => r.length <= 10),
  JSON.stringify(wrap("x".repeat(30), 10)));
check("wrap still breaks ASCII on spaces",
  JSON.stringify(wrap("aaaa bbbb cccc", 9)) === JSON.stringify(["aaaa bbbb", "cccc"]));

// ---- the grid --------------------------------------------------------------

const grid = (line: Line, width: number) => paint([line], width);

const wide = grid({ text: JP }, 40);
check("a wide glyph takes two cells, so the grid counts what the terminal draws",
  wide.height === 1 && cellAt(wide, 0, 0).char === JP[0] && cellAt(wide, 1, 0).char === "",
  JSON.stringify([wide.height, cellAt(wide, 0, 0).char, cellAt(wide, 1, 0).char]));

const marked = grid({ text: COMBINING }, 40);
check("a combining mark joins the cell before it rather than taking one",
  marked.height === 1 && cellAt(marked, 0, 0).char === COMBINING && cellAt(marked, 1, 0).char === " ",
  JSON.stringify([cellAt(marked, 0, 0).char, cellAt(marked, 1, 0).char]));

// 20 CJK chars are 40 columns, so at width 20 that is exactly two rows. Measured
// as code units it was one row of 20 cells claiming to be 40 columns wide.
const wrappedGrid = grid({ text: JP.repeat(4).slice(0, 20) }, 20);
check("a CJK row wraps in the grid at the column it reaches, not the unit",
  wrappedGrid.height === 2, `${wrappedGrid.height} row(s)`);

// The band fills to the row's width from the cell count, so an undercount left
// it short and broke the one element on screen that depends on being exact.
const banded = grid({ text: JP, band: true, width: 30, depth: 0 }, 30);
let filled = 0;
for (let x = 0; x < 30; x++) if (cellAt(banded, x, 0).sgr !== "") filled++;
check("a banded row with CJK in it still fills its whole width", filled === 30, `${filled} of 30`);

console.log(failures === 0 ? "\nwidth is measured in columns" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
