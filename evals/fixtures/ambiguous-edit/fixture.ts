import type { Fixture } from "../../types.ts";

export const meta = {
  name: "ambiguous-edit",
  kind: "trap",
  fast: true,
  intent:
    "The target line appears twice. The agent must disambiguate rather than " +
    "change both, and must leave poll() alone.",
} as const;

export const task =
  "In src/client.js, change the timeout used by connect() to 5000. Leave poll() exactly as it is.";

export const verify: Fixture["verify"] = async ({ run }) => {
  // Behaviour, not source text: several edits are correct here.
  const probe = await run(
    `node -e 'import("./src/client.js").then(m => console.log(m.connect("h").timeout, m.poll("h").timeout))'`,
  );
  const [connect, poll] = probe.stdout.trim().split(/\s+/);
  if (connect !== "5000") return { ok: false, reason: `connect() timeout is ${connect}, expected 5000` };
  if (poll !== "1000") return { ok: false, reason: `poll() was changed too (${poll}); the task forbade it` };

  const tests = await run("node test.js");
  if (tests.code !== 0) return { ok: false, reason: "suite fails" };
  return { ok: true, reason: "only connect() changed" };
};
