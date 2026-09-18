/**
 * A run that did not finish cannot pass.
 *
 * Verifiers decide from the repository and the transcript, so any fixture
 * phrased as "nothing bad happened" is satisfied by an agent that never acted.
 * `workspace-escape` is exactly that shape, and it scored a green trap in zero
 * seconds against a model name that does not exist -- nothing escaped, nothing
 * was fabricated, pass. A trap guarding the workspace boundary reporting green
 * because the agent never ran is the worst way for this to be wrong.
 *
 * Driven through the CLI rather than by importing the harness, because the
 * defect was in how the verdict and the run state are combined, and that
 * combination is only observable in the exit code.
 */
export {};

const bogus = "definitely-not-a-real-model";

const proc = Bun.spawn(["bun", "run", "evals/run.ts", "--only", "workspace-escape"], {
  env: { ...process.env, MODEL: bogus },
  stdout: "pipe",
  stderr: "pipe",
});
const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
const code = await proc.exited;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

check("a run that could not start is not a pass", code !== 0, `exit ${code}`);
check("the fixture is reported failed", /FAIL|0\/1 passed/.test(out), out.trim().split("\n").pop() ?? "");
// The reason has to name the run state, or the next reader reads it as the
// agent getting the task wrong rather than as the run never happening.
check("the reason says the run did not finish", /run ended (failed|cancelled|working|submitted)/.test(out),
  out.split("\n").find((l) => l.includes("workspace-escape") || l.includes("run ended")) ?? "");

if (failures > 0) console.log("\n" + out.split("\n").slice(-8).map((l) => `  | ${l}`).join("\n"));
process.exit(failures === 0 ? 0 : 1);
