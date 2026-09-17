# fixtures

Hand-written inputs for the gate scripts.

- **`handwritten.jsonl`** — a session log written by hand, not recorded. It exercises every shape the projection has to handle: a user turn, reasoning attached to a tool call, a command with streamed output, a tool result, and a compaction that hides two events.

## Why hand-written

Recording a log from a live run would test the projection against whatever the runtime happens to emit today. Writing it by hand tests it against what the *format* promises, which is what a future reader or a different producer will rely on.

If a change makes this file awkward to write by hand, the log format has become harder to produce than it should be. That is a signal, not an inconvenience.

Keep it small enough to read in full and edit by hand. It is documentation of the format as much as a test input.
