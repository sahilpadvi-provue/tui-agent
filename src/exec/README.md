# exec

Everything that touches the filesystem, spawns a process, or contains one.

## What lives here

- **`executor.ts`** — the interface. Read, write, exists, list, run.
- **`local.ts`** — local implementation against the user's working tree.
- **`sandbox.ts`** — OS policy generation (Seatbelt profiles, bubblewrap arguments).
- **`checkpoint.ts`** — git snapshots taken before destructive operations.

## Rules

**The interface stays async and stream-shaped.** Local execution does not need it; the container backend (phase 2) does, because it speaks HTTP. A synchronous signature here forces every caller to change later. Command output streams — a test suite emits for minutes.

**Resolve paths before checking them.** `../` and symlinks are only visible after resolution. Checking the raw string is the mistake behind CVE-2026-25592.

**Two implementations, no framework.** Local and container are the only backends. No strategy registry, no plugin system.

## Gotchas

- `spawn` uses `detached: true` so the child gets its own process group and `kill(-pid)` takes the whole tree. Without it, cancelling `npm test` orphans workers.
- **The sandbox cannot restrict reads.** Not on macOS, not on Linux, not anywhere. Secrets in the working tree are readable. Do not claim otherwise; the containment is writes and network egress.
- Checkpoints use a scratch `GIT_INDEX_FILE`. Running `git add -A` against the real index would silently stage everything the user had not staged.
- Persistence vectors (`.git/hooks`, `.git/config`, agent config, shell rc) are denied writes *inside* the workspace. A session that can write them survives the sandbox by running unsandboxed next launch.
