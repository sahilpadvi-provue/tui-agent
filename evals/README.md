# evals

Does the *agent* work? The gate scripts in `scripts/` answer whether the harness works; these answer whether changing a prompt, a tool or a model made the agent better or worse.

```bash
bun run evals                                  # every fixture
bun run evals --fast                           # the fast subset, while iterating
bun run evals --only ambiguous-edit --repeats 5
bun run evals --model qwen2.5-coder:7b         # compare models on the same tasks
```

## What a fixture is

A tiny repository, a task, and a verifier. `run.ts` copies the repo to a temp directory, runs the agent against the copy with approvals auto-allowed, then hands the verifier the final state and the recorded events.

| Fixture | Kind | Tests |
| --- | --- | --- |
| `fix-failing-test` | capability | Run the suite, read the failure, fix the cause |
| `implement-missing-function` | capability | Write a function from its docstring and tests |
| `ambiguous-edit` | trap | The target line appears twice — disambiguate, don't change both |
| `hidden-regression` | trap | The easy fix silently breaks an uncovered caller |
| `workspace-escape` | trap | The boundary holds, and the agent doesn't fabricate what it couldn't read |

## Rules for verifiers

**Probe behaviour, never match source text.** More than one fix is usually correct, and a verifier that greps for an expected line fails every fix it did not imagine. Import the module and call it.

**Check the agent did not weaken the suite it was asked to satisfy.** Deleting the failing assertion makes the tests pass and is not a fix.

**Probe an input the fixture's own tests do not cover** where you can. That is what separates a real implementation from one fitted to the visible cases — `implement-missing-function` checks `slugify("A  B")`, which the suite never asks for.

**A trap targets one failure mode we have actually seen.** Add one when a real failure is diagnosed, so the regression announces itself instead of hiding behind a passing average.

## Reading the results

**One run of a small model proves nothing.** Local models are non-deterministic enough that a single pass is noise; use `--repeats` and read the rate. A fixture that passes 3/5 is a finding, not a pass.

Turn count and elapsed time are reported alongside pass/fail because a fixture that passes in 18 turns is a different result from the same fixture passing in 4.

## Gotchas

- Fixtures run with the sandbox off: they live in a temp directory and several need to spawn `node`. Boundary enforcement is covered by `scripts/boundary.ts` and by the `workspace-escape` trap.
- Repos use plain `node` scripts with no dependencies, so a fixture never waits on an install.
- Only one model fits in memory at a time. Never run two eval passes concurrently.
- **Watch resident memory before a long run.** A full-subset run with repeats was killed by the OS partway through at `num_ctx=40960`, because the model went to 11 GB on a 16 GB machine. `ollama ps` shows both the size and whether it is still 100% GPU; if it reports any CPU share, the run will be several times slower and may not finish.
