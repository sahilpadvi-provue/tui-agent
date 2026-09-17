#!/bin/bash
# Controlled comparison: does num_ctx=16384 cost accuracy versus 40960?
# Same fixtures, same repeats, same model; only the window changes.
set -u
export PATH="/opt/homebrew/bin:$PATH"
REPEATS="${REPEATS:-3}"
OUT=/tmp/ctx-experiment
mkdir -p "$OUT"

for WINDOW in 16384 40960; do
  echo "=== num_ctx=$WINDOW  (repeats=$REPEATS) ==="
  start=$(date +%s)
  CONTEXT_WINDOW=$WINDOW bun run evals/run.ts --fast --repeats "$REPEATS" > "$OUT/$WINDOW.txt" 2>&1
  end=$(date +%s)
  echo "arm wall time: $((end - start))s"
  cat "$OUT/$WINDOW.txt"
  echo
done
