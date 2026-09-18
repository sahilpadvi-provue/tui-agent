/**
 * Colour, on a terminal that may not have much of it, in either theme.
 *
 * Two independent things are checked here and they are deliberately not the
 * same thing. A theme says what a colour *means*; the terminal's capabilities
 * say how much of that can be said. Folding them together is how you end up
 * with a role called "plain-when-suppressed".
 *
 * The capability half has already cost time once. A terminal that does not
 * understand `48;2;r;g;b` does not ignore it -- it reads the parameters as
 * separate SGR codes, and among `48;2;42;42;42` the `42` means "background
 * green", so the composer's band came out bright green and the shimmer's greys
 * came out violet. Nothing crashes and nothing logs; the screen is just wrong.
 */
import { spawnSync } from "node:child_process";
import { paint } from "../src/ui/render/screen.ts";
import { renderFrame } from "../src/ui/render/diff.ts";
import { THEMES, dark, light, ROLES, type Theme } from "../src/theme/index.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const bytes = (line: unknown) => renderFrame(null, paint([line as never], 40), 6);
const codes = (s: string): string[] => s.match(/\x1b\[[0-9;]+m/g) ?? [];

const bandRow = (t: Theme) =>
  bytes({
    text: "› test", band: t.band, width: 40, depth: 0,
    spans: [{ text: "› ", color: t.name }, { text: "test" }],
  });
/** Colour and weight together, which is what NO_COLOR has to separate. */
const weightedRow = (t: Theme) =>
  bytes({
    text: "chromelink", depth: 0,
    spans: [
      { text: "chrome", color: t.muted, dim: true },
      { text: "link", color: t.name, underline: true },
    ],
  });

const shimmerRow = (t: Theme) =>
  bytes({
    text: "wo", depth: 1,
    spans: [{ text: "w", color: t.shimmer[0] }, { text: "o", color: t.shimmer[4] }],
  });

// Before anything prints: the parent reads this child's whole stdout.
if (process.argv.includes("--emit")) {
  process.stdout.write(JSON.stringify(codes(bandRow(dark)).concat(codes(weightedRow(dark)))));
  process.exit(0);
}

const truecolor = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

// ---- the theme half --------------------------------------------------------
//
// A slot is a request the user's terminal answers, so it must reach the wire as
// a basic code rather than as a colour of ours. This is the decision that made
// dark and light differ in three values, and it is the one someone will later
// be tempted to undo by "just using hex everywhere".

for (const t of THEMES) {
  const named = codes(bytes({ text: "x", depth: 0, spans: [{ text: "x", color: t.name }] }));
  check(`${t.id}: a slot stays a basic code, so the user's palette answers it`,
    named.some((c) => c.includes("36")) && !named.some((c) => /38;[25];/.test(c)),
    named.join(" "));
}

check("both themes resolve every slot role identically",
  ROLES.filter((r) => dark[r].kind === "slot")
    .every((r) => JSON.stringify(dark[r]) === JSON.stringify(light[r])),
  ROLES.filter((r) => JSON.stringify(dark[r]) !== JSON.stringify(light[r])).join(", "));

check("and they differ only in the three the terminal has no opinion about",
  ROLES.filter((r) => JSON.stringify(dark[r]) !== JSON.stringify(light[r])).join(",") === "band,cursor,cursorText",
  ROLES.filter((r) => JSON.stringify(dark[r]) !== JSON.stringify(light[r])).join(", "));

// ---- the capability half ---------------------------------------------------

if (truecolor) {
  console.log("     COLORTERM advertises truecolor, so 24-bit is correct here");
  check("the dark band is 24-bit", codes(bandRow(dark)).some((c) => c.includes("48;2;42;42;42")));
} else {
  for (const t of THEMES) {
    const all = codes(bandRow(t)).concat(codes(shimmerRow(t)));
    check(`${t.id}: no 24-bit is emitted without COLORTERM`,
      !all.some((c) => /[34]8;2;/.test(c)), all.join(" "));
  }
  // The exact indices chalk picks, so the screen matches an Ink build. Both
  // arms are asserted, or the light theme could drift without anything saying.
  check("the dark band is the grey Ink would pick", codes(bandRow(dark)).some((c) => c.includes("48;5;235")),
    codes(bandRow(dark)).join(" "));
  check("the light band is the grey Ink would pick", codes(bandRow(light)).some((c) => c.includes("48;5;254")),
    codes(bandRow(light)).join(" "));
  check("the dark shimmer head is Ink's white", codes(shimmerRow(dark)).some((c) => c.includes("38;5;231")),
    codes(shimmerRow(dark)).join(" "));
  check("and the light shimmer head is dark, not white",
    !codes(shimmerRow(light)).some((c) => c.includes("38;5;231")),
    codes(shimmerRow(light)).join(" "));
}

// ---- NO_COLOR --------------------------------------------------------------
//
// A capability, never a theme. Run in a child because the rule is read once at
// module load and no env var can be changed after that from inside.

const self = new URL(import.meta.url).pathname;
const emitted = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["run", self, "--emit"], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as string[];
  } catch {
    return null;
  }
};

const plain = emitted({ NO_COLOR: "1" });
const coloured = emitted({ NO_COLOR: "" });
check("the child emitted in both arms", plain !== null && coloured !== null,
  JSON.stringify([plain, coloured]));
if (plain && coloured) {
  check("NO_COLOR emits no colour at all",
    !plain.some((c) => /[34]8;/.test(c)) && !plain.some((c) => /\b3[0-7]\b|\b9[0-7]\b/.test(c)),
    plain.join(" "));
  // The secondary tier of this UI rests entirely on dim. Suppressing weight as
  // well would collapse three tiers into one and take the hierarchy with it.
  check("but weight survives it", plain.some((c) => /\x1b\[(?:\d+;)*2(?:;\d+)*m/.test(c)), plain.join(" "));
  // A link is exactly where findability matters most on a monochrome terminal,
  // so underline has to survive for the same reason dim does.
  check("and so does underline, so a link is still a link without colour",
    plain.some((c) => /\x1b\[(?:\d+;)*4(?:;\d+)*m/.test(c)), plain.join(" "));
  check("and without it colour comes back", coloured.some((c) => /[34]8;5;/.test(c)),
    coloured.join(" "));
}

console.log(failures === 0 ? "\ncolour survives both themes and a terminal without much" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
