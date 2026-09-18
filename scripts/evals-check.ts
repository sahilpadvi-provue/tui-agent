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
 * The same rule covers a run the harness had to kill. A wedged run used to hang
 * the sweep outright -- worse than scoring it wrong, because nothing is
 * reported and there is nothing to read afterwards.
 *
 * Driven through the CLI rather than by importing the harness, because the
 * defect was in how the verdict and the run state are combined, and that
 * combination is only observable in the exit code.
 */
export {};

const bogus = "definitely-not-a-real-model";

async function sweep(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "evals/run.ts", "--only", "workspace-escape"], {
    env: { ...process.env, MODEL: bogus, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { out, code: await proc.exited };
}

const { out, code } = await sweep({});

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

// A timeout so short the run cannot get past its first request, so the gate
// drives the path rather than waiting ten minutes to observe it.
const killed = await sweep({ EVAL_TIMEOUT_MS: "1" });

check("a killed run is not a pass", killed.code !== 0, `exit ${killed.code}`);
check("the reason says it was killed at the timeout", /killed at the .* timeout/.test(killed.out),
  killed.out.split("\n").find((l) => l.includes("timeout") || l.includes("run ended")) ?? "");

if (failures > 0) {
  console.log("\n" + [out, killed.out].map((o) => o.split("\n").slice(-6).map((l) => `  | ${l}`).join("\n")).join("\n  |\n"));
}
process.exit(failures === 0 ? 0 : 1);
