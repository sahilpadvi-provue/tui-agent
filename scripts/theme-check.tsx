/**
 * The theme reaches the screen, and `/theme` changes it.
 *
 * `colour-check` asserts what each theme resolves to; this asserts that the
 * screen actually asks. Those are different failures: a component holding a
 * leftover constant passes the first and fails the second, and that constant
 * is exactly what this change removed two of.
 */
import React from "react";
import { spawnSync } from "node:child_process";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { screen } from "./vt.ts";
import { runCommand, type CommandContext } from "../src/commands/registry.ts";
import { dark, light, themeNamed, type Theme } from "../src/theme/index.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drives a real request through the app and returns the SGR codes it wrote. */
async function codesFor(theme: Theme): Promise<string[]> {
  const vt = screen(80, 24);
  const bus = new EventBus();
  const app = mount(
    <App theme={theme} bus={bus} cwd="/tmp/demo" model="m" version="0" backend="b"
         sandbox="off" busy={false} onSubmit={() => {}} onCommand={() => {}}
         onCancel={() => {}} onPermission={() => {}} />,
    { stdout: vt.stdout, stdin: vt.stdin },
  );
  await wait(130);
  // A request row is the banded one, which is where the theme is most visible.
  bus.emit({ sessionId: "s", type: "message.started", id: "u0", role: "user" });
  bus.emit({ sessionId: "s", type: "message.completed", id: "u0", text: "do the thing" });
  await wait(160);
  const out = vt.raw();
  app.unmount();
  await app.waitUntilExit();
  return out.match(/\x1b\[[0-9;]+m/g) ?? [];
}

if (process.argv.includes("--emit")) {
  const chosen = themeNamed(process.env.THEME ?? "") ?? dark;
  process.stdout.write(chosen.id);
  process.exit(0);
}

// ---- the screen asks the theme ---------------------------------------------

const darkCodes = await codesFor(dark);
const lightCodes = await codesFor(light);

check("a request row is banded with the dark theme's grey",
  darkCodes.some((c) => c.includes("48;5;235")), darkCodes.slice(0, 8).join(" "));
check("and with the light theme's, from the same component",
  lightCodes.some((c) => c.includes("48;5;254")), lightCodes.slice(0, 8).join(" "));
check("neither leaks the other's band",
  !darkCodes.some((c) => c.includes("48;5;254")) && !lightCodes.some((c) => c.includes("48;5;235")));

// ---- selection -------------------------------------------------------------

const self = new URL(import.meta.url).pathname;
const chosen = (env: Record<string, string>) =>
  (spawnSync(process.execPath, ["run", self, "--emit"], { encoding: "utf8", env: { ...process.env, ...env } })
    .stdout ?? "").trim();

check("THEME picks a theme at launch", chosen({ THEME: "light" }) === "light", chosen({ THEME: "light" }));
check("an unset THEME is dark", chosen({ THEME: "" }) === "dark", chosen({ THEME: "" }));
// Falling back rather than failing: a mistyped theme is not a reason to refuse
// to start, and the alternative is a crash on a typo in a shell profile.
check("and a name that is not a theme falls back rather than failing",
  chosen({ THEME: "nonsense" }) === "dark", chosen({ THEME: "nonsense" }));

// ---- /theme ----------------------------------------------------------------

let current: Theme = dark;
const ctx = {
  sessionId: "s", cwd: "/tmp", history: [], model: "m",
  availableModels: async () => [],
  setModel: () => {}, clear: () => {}, restore: () => {}, resume: () => {},
  get theme() { return current.id; },
  setTheme: (t: Theme) => { current = t; },
} as unknown as CommandContext;

const listed = await runCommand("/theme", ctx);
check("/theme with no argument lists what there is",
  listed.ok && listed.output.includes("dark") && listed.output.includes("light"), listed.output);
check("and marks the one showing", listed.output.includes("› dark"), JSON.stringify(listed.output));

const switched = await runCommand("/theme light", ctx);
check("/theme light switches", switched.ok && current.id === "light", switched.output);

const bad = await runCommand("/theme nonsense", ctx);
check("/theme with a name that is not a theme is refused", !bad.ok, bad.output);
check("and leaves the theme alone", current.id === "light", current.id);

console.log(failures === 0 ? "\nthe theme reaches the screen" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
