/**
 * Emphasis must survive the renderer, not just its markers.
 *
 * Stripping `**` and rendering the word plain looks almost right and is not:
 * the whole reason inline markdown exists here is that models emit it
 * constantly, and a reply where nothing is emphasised reads as flat. So this
 * asserts the styling bytes, not the text.
 *
 * Both renderers go through `segments` and `blockStyle` in src/ui/markdown.tsx
 * so the two cannot drift; what this guards is that the cell renderer uses
 * them at all. It painted markdown as plain text until it did, which would
 * have shipped raw asterisks in every assistant reply.
 */
import { paint } from "../src/ui/render/screen.ts";
import { renderFrame } from "../src/ui/render/diff.ts";
import { slot } from "../src/theme/index.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const frame = (text: string) => renderFrame(null, paint([{ text, depth: 0, md: slot("cyan") } as never], 60), 6);
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
/**
 * The styling in force where `word` is drawn.
 *
 * Not the escape immediately before it: a run of cells sharing a style is
 * emitted with one prefix, so a bold heading's prefix sits before its
 * indent rather than before its first letter. Looking only at the character
 * boundary reported a correctly-bold heading as unstyled.
 */
const sgrOn = (frameBytes: string, word: string) => {
  const at = frameBytes.indexOf(word);
  if (at === -1) return "";
  return /((?:\x1b\[[0-9;]*m)+)[^\x1b]*$/.exec(frameBytes.slice(0, at))?.[1] ?? "";
};

const bold = frame("use **replace_lines** here");
check("bold markers are gone", plain(bold) === "use replace_lines here", plain(bold));
check("and the word is actually bold", sgrOn(bold, "replace_lines").includes("1"), sgrOn(bold, "replace_lines"));

const code = frame("run `npm test` now");
check("code markers are gone", plain(code) === "run npm test now", plain(code));
check("and the span is tinted", sgrOn(code, "npm").includes("36"), sgrOn(code, "npm"));

const heading = frame("## Heading");
check("a heading loses its hashes", plain(heading) === "Heading", plain(heading));
check("and is bold instead", sgrOn(heading, "Heading").includes("1"), sgrOn(heading, "Heading"));

check("a bullet becomes a bullet", plain(frame("- a bullet")) === "• a bullet", plain(frame("- a bullet")));

// A line that is not markdown must be left exactly as it is.
const raw = renderFrame(null, paint([{ text: "a ** b ` c", depth: 0 } as never], 60), 6);
check("a non-markdown line is untouched", plain(raw) === "a ** b ` c", plain(raw));

console.log(failures === 0 ? "\nemphasis survives the cell renderer" : `\n${failures} failed`);
// ---------------------------------------------------------------------------
// Emphasis has to survive the line break, and a table has to hold its columns
// ---------------------------------------------------------------------------

const { wrapSpans, blocks, tableLines } = await import("../src/ui/markdown.tsx");
const { displayWidth } = await import("../src/ui/layout.ts");
const { dark } = await import("../src/theme/index.ts");

const long = "The parser **strips whitespace that was inside the quotes** and is wrong.";
const wrapped = wrapSpans(long, 40, dark);
const asText = wrapped.map((l) => l.map((s) => s.text).join(""));

const boldLines = wrapped.filter((l) => l.some((s) => s.bold)).length;
check("the phrase spans more than one line at this width", wrapped.length > 1, asText.join(" / "));
check("and both of its halves are still bold", boldLines === 2, `${boldLines} of ${wrapped.length}`);
check("and never shows its markers",
  !asText.join("").includes("**"),
  "wrapping before parsing splits the pair and renders both halves raw");
check("every wrapped line fits the width",
  asText.every((l) => displayWidth(l) <= 40), asText.map(displayWidth).join(","));

const md = `| Option | Detail |
| --- | --- |
| **Name** | A sentence long enough that it has to wrap inside its column. |
| \`code\` | https://example.com/a/very/long/url/that/exceeds/its/column/width |`;

const parsed = blocks(md);
check("a table is recognised as a block", parsed.length === 1 && parsed[0]?.kind === "table");
check("two pipes in a sentence are not a table",
  blocks("a | b and c | d").every((b) => b.kind === "text"));

if (parsed[0]?.kind === "table") {
  const lines = tableLines(parsed[0].table, 60, 0, dark);
  const widths = lines.map((l) => displayWidth(l.text));
  check("every row of a table is the same width",
    new Set(widths).size === 1, [...new Set(widths)].join(","));
  check("and none of them exceeds it", widths.every((w) => w <= 60), `${Math.max(...widths)} of 60`);
  check("a url too wide for its column is broken, not left to shear the table",
    lines.some((l) => l.text.includes("example.com")) && Math.max(...widths) <= 60);
  check("the header is weight, not colour",
    lines[0]?.spans?.some((s) => s.bold) === true
      && lines[0]?.spans?.every((s) => s.color === undefined || s.color === dark.muted) === true,
    "every colour on this screen already means something, and heading is not one");
}

process.exit(failures === 0 ? 0 : 1);
