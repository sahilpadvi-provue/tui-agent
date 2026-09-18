/**
 * Both renderers, one answer.
 *
 * A contract with a single implementation behind it is a guess. This drives
 * the same tree through the cell renderer and through Ink and holds them to
 * the same visible rows, so the boundary in `primitives.tsx` is checked on
 * every run rather than at the next swap -- which is the only time the cost of
 * a leak is ever discovered otherwise.
 *
 * Geometry is included deliberately. Borders, `align="between"` and `padX`
 * are where a flexbox engine and a line model could plausibly disagree, so
 * they are the rows worth comparing.
 */
import React, { useState } from "react";
import { PassThrough, Writable } from "node:stream";
import { Stack, Label, Settled, useKeys, mount, renderToText } from "../src/ui/primitives.tsx";
import { App } from "../src/ui/App.tsx";
import { EventBus } from "../src/core/bus.ts";
import type { Backend } from "../src/ui/backend.ts";
import { cellsBackend } from "../src/ui/backends/cells.tsx";
import { inkBackend } from "../src/ui/backends/ink.tsx";
import { dark, rgb, slot } from "../src/theme/index.ts";
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const backends: Backend[] = [cellsBackend, inkBackend];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeTty = () => {
  const frames: { out: string } = { out: "" };
  const stdout = Object.assign(
    new Writable({ write(c, _e, cb) { frames.out += String(c); cb(); return true; } }),
    { columns: 48, rows: 20, isTTY: true },
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  return { frames, stdout: stdout as any, stdin: stdin as any };
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

// Before anything prints: the parent reads this child's whole stdout.
if (process.argv.includes("--attrs")) {
  const which = process.argv[process.argv.indexOf("--attrs") + 1];
  const backend = which === "ink" ? inkBackend : cellsBackend;
  const { frames, stdout, stdin } = fakeTty();
  const app = mount(<Stack><Label underline>link</Label></Stack>, { stdout, stdin, backend });
  await wait(160);
  app.unmount();
  await app.waitUntilExit();
  process.stdout.write(JSON.stringify(frames.out.match(/\x1b\[[0-9;]+m/g) ?? []));
  process.exit(0);
}


// ---------------------------------------------------------------- same answer

/**
 * `Settled` first, which is the only position the contract allows and the
 * position `App` uses. Ink implements it with `Static`, whose output is
 * prepended to the frame rather than placed in tree order.
 */
const shared = (
  <Stack>
    <Settled items={["settled one", "settled two"]} render={(t, i) => <Label key={i}>{t}</Label>} />
    <Label>plain row</Label>
    <Label color={slot("cyan")} bold>tinted and bold</Label>
    <Label>
      {"outer "}
      <Label color={slot("green")}>inner</Label>
      {" tail"}
    </Label>
    {/* A newline is a row break in both, not a cell. The cell renderer used
        to keep it, which put a raw LF inside a row the diff counted as one
        and desynchronised every row after it. */}
    <Label>{"broken\nacross rows"}</Label>
    <Label underline>underlined</Label>
    <Stack direction="row">
      <Label>left</Label>
      <Label>right</Label>
    </Stack>
    <Stack border borderColor={slot("cyan")}>
      <Label>boxed</Label>
    </Stack>
    <Stack direction="row" align="between">
      <Label>start</Label>
      <Label>end</Label>
    </Stack>
    <Stack padX={2}>
      <Label>padded</Label>
    </Stack>
  </Stack>
);

const rendered = backends.map((b) => ({ name: b.name, rows: renderToText(shared, 40, b) }));
const [first, ...others] = rendered;

for (const other of others) {
  check(
    `${other.name} draws the same rows as ${first!.name}`,
    JSON.stringify(other.rows) === JSON.stringify(first!.rows),
    `\n  ${first!.name}: ${JSON.stringify(first!.rows)}\n  ${other.name}: ${JSON.stringify(other.rows)}`,
  );
}

// Every backend must actually have drawn the content, or agreeing on nothing
// would pass the comparison above.
for (const { name, rows } of rendered) {
  const text = rows.join("\n");
  check(`${name} drew every element`, [
    "settled one", "settled two", "plain row", "tinted and bold",
    "outer inner tail", "leftright", "boxed", "padded", "underlined",
  ].every((s) => text.includes(s)), JSON.stringify(rows));
  check(`${name} breaks a row on a newline rather than drawing it`,
    rows.includes("broken") && rows.includes("across rows")
      && !rows.some((r) => r.includes("\n")),
    JSON.stringify(rows));
  check(`${name} drew the rule and the pushed edge`,
    /^─+$/.test(rows.find((r) => r.startsWith("─")) ?? "") && /start +end$/.test(
      rows.find((r) => r.includes("start")) ?? ""),
    JSON.stringify(rows));
}

/**
 * The "Settled first" rule is load-bearing, not a style note: with it anywhere
 * else the two backends disagree, because `Static` prepends. Asserting the
 * divergence is what keeps the rule from being deleted as arbitrary.
 */
const misplaced = (
  <Stack>
    <Label>above</Label>
    <Settled items={["moved"]} render={(t, i) => <Label key={i}>{t}</Label>} />
  </Stack>
);
check(
  "a Settled that is not the first child is where the two diverge",
  JSON.stringify(renderToText(misplaced, 40, cellsBackend))
    !== JSON.stringify(renderToText(misplaced, 40, inkBackend)),
  "both agreed, so the contract's ordering rule is no longer load-bearing",
);

// ------------------------------------------------------------------- real App

/**
 * The synthetic tree above is chosen to exercise the contract; this is the
 * screen that actually ships. Rendering it through both backends is the only
 * assertion that speaks to the product rather than to the abstraction.
 *
 * `align="between"` is a measured divergence, not a bug either side: a flex
 * engine subtracts the container's `padX` from the free space it distributes,
 * while the line model fills to the terminal edge, so the footer's elastic gap
 * differs by two columns. Content, order and every fixed row still match, so
 * the comparison collapses whitespace runs rather than pretending otherwise.
 */
const app = (
  <App theme={dark} bus={new EventBus()} cwd="/tmp/demo" model="qwen3:8b" version="0.1.0"
       backend="ollama" sandbox="seatbelt" branch="main" busy={false}
       onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}} onPermission={() => {}} />
);
const appRows = backends.map((b) => renderToText(app, 90, b));
const [appFirst, ...appOthers] = appRows;
/**
 * Interior runs only. Collapsing leading whitespace too would hide a padding
 * regression, which is the other thing a flex engine and a line model can
 * disagree about, and the one that moves every row on screen.
 */
const collapse = (r: string) => r.replace(/(\S) {2,}(?=\S)/g, "$1 ").replace(/\s+$/, "");

for (const [i, rows] of appOthers.entries()) {
  const name = backends[i + 1]!.name;
  check(`the real App renders the same content on ${name}`,
    rows.length === appFirst!.length
      && rows.every((r, n) => collapse(r) === collapse(appFirst![n] ?? "")),
    `\n  ${backends[0]!.name}: ${JSON.stringify(appFirst)}\n  ${name}: ${JSON.stringify(rows)}`);

  const differing = rows
    .map((r, n) => (r === appFirst![n] ? -1 : n))
    .filter((n) => n >= 0);
  check(`and differs from ${backends[0]!.name} only in elastic fill`,
    differing.every((n) => collapse(rows[n]!) === collapse(appFirst![n] ?? "")),
    `rows ${JSON.stringify(differing)}`);
  check(`${name} drew the App's banner, composer and footer`,
    ["tui-agent", "describe a change", "qwen3:8b"].every((t) => rows.join("\n").includes(t)),
    JSON.stringify(rows));
}

// ---------------------------------------------------------------- attributes
//
// `renderToText` strips escapes, so the comparison above proves both backends
// draw the same characters and says nothing about weight. An attribute
// forwarded in one backend and forgotten in the other looks identical there.
// Ink fixes its colour level when chalk is imported, so its arm runs in a
// child with FORCE_COLOR set.

const selfPath = new URL(import.meta.url).pathname;
const attrCodes = (which: string) => {
  const r = spawnSync(process.execPath, ["run", selfPath, "--attrs", which], {
    encoding: "utf8", env: { ...process.env, FORCE_COLOR: "3" },
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as string[];
  } catch {
    return null;
  }
};
const underlines = (cs: string[] | null) =>
  cs !== null && cs.some((c) => /\[(?:\d+;)*4(?:;\d+)*m/.test(c));

for (const which of ["cells", "ink"]) {
  const cs = attrCodes(which);
  check(`${which} emits SGR 4 for an underlined span`, underlines(cs),
    JSON.stringify(cs));
}

// ------------------------------------------------------------------ live mount

function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  useKeys(() => setN((v) => v + 1));
  return <Stack><Label>{`${label} n=${n}`}</Label></Stack>;
}

for (const backend of backends) {
  const { frames, stdout, stdin } = fakeTty();
  let painted = 0;
  const app = mount(<Counter label="live" />, {
    stdout, stdin, backend, onRender: () => { painted++; },
  });

  await wait(150);
  check(`${backend.name} writes a frame`, plain(frames.out).includes("live n=0"),
    JSON.stringify(plain(frames.out).slice(-120)));
  check(`${backend.name} reports the frames it painted`, painted > 0, `${painted}`);

  frames.out = "";
  stdin.write("x");
  await wait(150);
  check(`${backend.name} delivers a keystroke to useKeys`,
    plain(frames.out).includes("live n=1"), JSON.stringify(plain(frames.out).slice(-120)));

  // The regression this gate exists to prevent twice over: a rerender that
  // changes the root element's type remounts the tree and silently resets
  // every piece of UI state.
  frames.out = "";
  app.rerender(<Counter label="again" />);
  await wait(150);
  check(`${backend.name} rerenders without remounting`,
    plain(frames.out).includes("again n=1"), JSON.stringify(plain(frames.out).slice(-120)));

  app.unmount();
  await app.waitUntilExit();
  check(`${backend.name} unmount resolves waitUntilExit`, true);
}

console.log(failures ? "" : "\nthe renderer contract holds for every backend");
process.exit(failures ? 1 : 0);
