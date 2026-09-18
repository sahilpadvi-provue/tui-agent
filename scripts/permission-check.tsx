/**
 * A permission prompt must not answer itself with a keystroke meant for the
 * composer.
 *
 * The prompt replaces the composer in place, so the key already on its way was
 * aimed at the sentence the user was writing, not at a question they had not
 * seen yet. It bound `y` to allow as the very first thing it checked, which
 * makes a stray keystroke on a destructive command the worst case in the
 * application.
 *
 * The parser batches a fast typing run into a single event, so `char` is "yes"
 * and never matched "y" -- fast typing was accidentally safe. Slow typing was
 * not: each character arrives as its own event, and the first one grants.
 */
import React from "react";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";
import { mount } from "../src/ui/primitives.tsx";
import { screen } from "./vt.ts";
import type { PermissionDecision } from "../src/core/events.ts";
import { dark } from "../src/theme/index.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mounts the app, raises a permission request, then sends keys with the gaps
 * asked for. Real time, because the guard is a time window and faking it would
 * test the fake.
 */
async function ask(keys: { key: string; afterMs: number }[]) {
  const vt = screen(80, 24);
  const bus = new EventBus();
  const decisions: PermissionDecision[] = [];
  const app = mount(
    <App theme={dark} bus={bus} cwd="/tmp/demo" model="m" version="0" backend="b" sandbox="off" busy={true}
         onSubmit={() => {}} onCommand={() => {}} onCancel={() => {}}
         onPermission={(d) => decisions.push(d)} />,
    { stdout: vt.stdout, stdin: vt.stdin },
  );
  await wait(120);
  // Typing, mid-sentence, exactly as the prompt lands.
  vt.stdin.write("do ");
  await wait(40);
  bus.emit({
    sessionId: "s",
    type: "permission.requested",
    requestId: "p0",
    callId: "c0",
    tool: "shell",
    blastRadius: { writes: ["/tmp/demo/dist"], network: false },
  });
  await wait(60);
  for (const k of keys) {
    await wait(k.afterMs);
    vt.stdin.write(k.key);
  }
  await wait(150);
  const frame = vt.all().join("\n");

  // The prompt replaces the composer while it is up, so what the user was
  // typing can only be looked for once the decision has cleared it.
  bus.emit({
    sessionId: "s",
    type: "permission.resolved",
    requestId: "p0",
    decision: decisions[0] ?? { kind: "deny", reason: "unanswered" },
  });
  await wait(180);
  const after = vt.all().join("\n");

  app.unmount();
  await app.waitUntilExit();
  return { decisions, frame, after };
}

// ---- the stray keystroke ---------------------------------------------------

const inFlight = await ask([{ key: "y", afterMs: 0 }]);
check("a key arriving as the prompt appears does not answer it",
  inFlight.decisions.length === 0, JSON.stringify(inFlight.decisions));
check("and the prompt is still on screen waiting",
  /approve|\[y\]/.test(inFlight.frame), inFlight.frame.slice(-200));

// Someone typing "do it anyway" one character at a time: every one of those
// keys lands on the prompt, and two of them are bound.
const run = await ask(
  [..."it anyway"].map((c) => ({ key: c, afterMs: 90 })),
);
check("a slow typing run never answers it, even past the guard",
  run.decisions.length === 0, JSON.stringify(run.decisions));

// ---- a real answer ---------------------------------------------------------

const allowed = await ask([{ key: "y", afterMs: 400 }]);
check("a key pressed after a pause allows once",
  allowed.decisions.length === 1 && allowed.decisions[0]?.kind === "allow"
    && (allowed.decisions[0] as { scope?: string }).scope === "once",
  JSON.stringify(allowed.decisions));

const session = await ask([{ key: "a", afterMs: 400 }]);
check("and `a` allows for the session",
  (session.decisions[0] as { scope?: string } | undefined)?.scope === "session",
  JSON.stringify(session.decisions));

const denied = await ask([{ key: "n", afterMs: 400 }]);
check("`n` denies", denied.decisions[0]?.kind === "deny", JSON.stringify(denied.decisions));

const escaped = await ask([{ key: "\x1b", afterMs: 400 }]);
check("esc denies too, which the prompt does not say",
  escaped.decisions[0]?.kind === "deny", JSON.stringify(escaped.decisions));

// ---- what the user was typing ----------------------------------------------

// The decision must not cost them the line they were part-way through, or the
// guard would be trading one loss for another.
const kept = await ask([{ key: "y", afterMs: 400 }]);
check("the half-written line is still there once the prompt clears",
  /\u203a do/.test(kept.after),
  JSON.stringify(kept.after.split("\n").filter((r) => r.includes("\u203a")).slice(-2)));

console.log(failures === 0 ? "\nthe prompt cannot answer itself" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
