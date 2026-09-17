import type { Fixture } from "../../types.ts";

export const meta = {
  name: "implement-missing-function",
  kind: "capability",
  fast: true,
  intent: "Write a function from its docstring and tests, then confirm it passes.",
} as const;

export const task = "Implement slugify in src/slugify.js so that 'node test.js' passes.";

export const verify: Fixture["verify"] = async ({ run, read }) => {
  const tests = await run("node test.js");
  if (tests.code !== 0) return { ok: false, reason: "suite fails" };

  const src = await read("src/slugify.js");
  if (src.includes("not implemented")) {
    return { ok: false, reason: "the stub is still throwing" };
  }
  // Probe a case the suite does not cover: a correct implementation generalises.
  const probe = await run(
    `node -e 'import("./src/slugify.js").then(m => console.log(m.slugify("A  B")))'`,
  );
  if (probe.stdout.trim() !== "a-b") {
    return { ok: false, reason: `hardcoded to the tests: slugify("A  B") gave ${probe.stdout.trim()}` };
  }
  return { ok: true, reason: "passes, and generalises to an uncovered input" };
};
