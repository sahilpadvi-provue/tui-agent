# scripts

Gate scripts. Each one is a claim about the system that can fail loudly.

| Script | Claim it tests |
| --- | --- |
| `replay.ts` | A log alone reconstructs a conversation, and compaction is reversible |
| `boundary.ts` | Path traversal and absolute paths cannot escape the workspace |
| `sandbox-check.ts` | The OS sandbox blocks writes outside the workspace and network egress |
| `checkpoint-check.ts` | A checkpoint restores damage without touching the user's git state |
| `bench.tsx` | Render cost stays flat on a long transcript under streaming |
| `ui-smoke.tsx` | The UI renders a frame, including the permission prompt |
| `frame-dump.tsx` | Not a gate — prints the rendered frame line by line, for layout work |

## Rules

**A gate asserts, it does not describe.** Every script exits non-zero on failure. A script that prints information without a pass/fail verdict belongs somewhere else.

**Gates test the claim, not the implementation.** `boundary.ts` attempts real escapes; `sandbox-check.ts` runs real commands through `sandbox-exec`; `checkpoint-check.ts` destroys a real file and checks it comes back. A gate that mocks what it is testing proves nothing.

Run the one covering what you changed. Run all before calling phase work done.

## Gotchas

- `bench.tsx` and `ui-smoke.tsx` need fake `stdin` with `isTTY: true` and a `setRawMode` stub, or Ink throws on `useInput`.
- `bench.tsx` reports low stdout volume because the viewport slices a data array. That is the result being measured, not a flaw in the measurement.
