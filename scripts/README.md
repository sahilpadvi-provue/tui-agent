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
| `cancel-check.ts` | Esc kills the whole process tree and keeps what was already printed |
| `resume-check.ts` | A resumed session carries its history, continues its sequence, and refuses the wrong tree |
| `resume-ui-check.tsx` | The terminal client launches into a session, picks one from a list, and switches without quitting |
| `changed-check.ts` | What a call did to the workspace reaches the view model, created distinct from modified |
| `width-check.ts` | Width is display columns: no split surrogate, CJK wraps, a wide glyph takes two cells |
| `log-equivalence.tsx` | Mounting the UI changes nothing the runtime records |
| `queue-check.tsx` | Typing is never blocked; Enter queues and the queue flushes on idle |
| `backend-check.tsx` | Every renderer backend draws the same screen, for the synthetic tree and for the real `App` |
| `keys-check.tsx` | Every key binding edits what it claims to, read back through the text the composer submits |
| `frame-dump.tsx` | Not a gate — prints the rendered frame line by line, for layout work |

## Rules

**A gate asserts, it does not describe.** Every script exits non-zero on failure. A script that prints information without a pass/fail verdict belongs somewhere else.

**Gates test the claim, not the implementation.** `boundary.ts` attempts real escapes; `sandbox-check.ts` runs real commands through `sandbox-exec`; `checkpoint-check.ts` destroys a real file and checks it comes back. A gate that mocks what it is testing proves nothing.

Run the one covering what you changed. Run all before calling phase work done.

## Gotchas

- Anything that mounts needs fake `stdin` with `isTTY: true` and a `setRawMode` stub, or no key ever arrives -- and under the Ink backend `useInput` throws outright.
- `bench.tsx` reports low stdout volume because the viewport slices a data array. That is the result being measured, not a flaw in the measurement.
