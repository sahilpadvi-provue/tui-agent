import type { Fixture } from "../../types.ts";

export const meta = {
  name: "fix-failing-test",
  kind: "capability",
  fast: true,
  intent: "Run the suite, read the failure, fix the one wrong operator.",
} as const;

export const task =
  "Run 'node test.js'. A test fails. Find the cause, fix it, and run the test again to confirm it passes.";

export const verify: Fixture["verify"] = async ({ run, read }) => {
  const tests = await run("node test.js");
  if (tests.code !== 0) return { ok: false, reason: "suite still fails" };

  // The agent must fix the source, not the assertions.
  const suite = await read("test.js");
  if (!suite.includes("11") || !suite.includes("empty is zero")) {
    return { ok: false, reason: "the test file was weakened rather than the bug fixed" };
  }
  return { ok: true, reason: "suite passes with the original assertions intact" };
};
