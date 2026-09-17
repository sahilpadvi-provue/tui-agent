/**
 * The renderer must not assume truecolor.
 *
 * A terminal that does not understand `48;2;r;g;b` does not ignore it. It
 * reads the parameters as separate SGR codes, and among `48;2;42;42;42` the
 * `42` means "background green" -- so the composer's #2a2a2a band came out
 * bright green and the shimmer's greys came out violet. Nothing crashes and
 * nothing logs; the screen is just the wrong colour.
 *
 * Ink never hit this because chalk downgrades for it. This checks we match.
 */
import { paint } from "../src/ui/render/screen.ts";
import { renderFrame } from "../src/ui/render/diff.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const bytes = (line: unknown) => renderFrame(null, paint([line as never], 40), 6);
const codes = (s: string): string[] => s.match(/\x1b\[[0-9;]+m/g) ?? [];

const band = bytes({
  text: "› test", band: true, width: 40, depth: 0,
  spans: [{ text: "› ", color: "cyan" }, { text: "test" }],
});
const shimmer = bytes({
  text: "wo", depth: 1,
  spans: [{ text: "w", color: "#ffffff" }, { text: "o", color: "#5f5f5f" }],
});

const truecolor = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

if (truecolor) {
  console.log("     COLORTERM advertises truecolor, so 24-bit is correct here");
  check("the band is 24-bit", codes(band).some((c) => c.includes("48;2;42;42;42")));
} else {
  check("no 24-bit foreground is emitted", !codes(band).concat(codes(shimmer)).some((c) => /38;2;/.test(c)),
    codes(shimmer).join(" "));
  check("no 24-bit background is emitted", !codes(band).some((c) => /48;2;/.test(c)), codes(band).join(" "));
  // The exact indices chalk picks, so the screen matches the Ink build.
  check("the band is the same grey Ink uses", codes(band).some((c) => c.includes("48;5;235")),
    codes(band).join(" "));
  check("white is the same white Ink uses", codes(shimmer).some((c) => c.includes("38;5;231")),
    codes(shimmer).join(" "));
}

// Named colours were never affected, and must stay on the basic codes.
const named = bytes({ text: "x", depth: 0, spans: [{ text: "x", color: "cyan" }] });
check("named colours stay basic", codes(named).some((c) => c.includes("36")), codes(named).join(" "));

console.log(failures === 0 ? "\ncolour survives a terminal without truecolor" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
