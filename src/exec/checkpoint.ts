import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/**
 * Git checkpoints taken before destructive operations.
 *
 * The most-cited destructive failure in this category is git-shaped: agents
 * running `git checkout --` over uncommitted work, or losing a stash. A
 * checkpoint is a real commit object written to a shadow ref, so the user's
 * branch, index, stash stack and working tree are all untouched -- and the
 * content is recoverable with ordinary git commands afterwards.
 */

const SHADOW_REF = "refs/agent/checkpoints";

function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

export function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd).stdout?.trim() === "true";
}

export type Checkpoint = {
  readonly commit: string;
  readonly at: string;
  readonly label: string;
};

/**
 * Snapshot the working tree. Uses a scratch index file so the user's staged
 * changes are never disturbed -- `git add -A` against the real index would
 * silently stage everything they had not staged yet.
 */
export function checkpoint(cwd: string, label: string): Checkpoint | null {
  if (!isGitRepo(cwd)) return null;

  const indexFile = join(mkdtempSync(join(tmpdir(), "agent-ckpt-")), "index");
  const env = { GIT_INDEX_FILE: indexFile };

  if (git(["add", "-A"], cwd, env).status !== 0) return null;
  const tree = git(["write-tree"], cwd, env).stdout?.trim();
  if (!tree) return null;

  const parent = git(["rev-parse", SHADOW_REF], cwd).stdout?.trim();
  const args = ["commit-tree", tree, "-m", `agent checkpoint: ${label}`];
  if (parent && !parent.startsWith("refs/")) args.push("-p", parent);

  const commit = git(args, cwd, {
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@local",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@local",
  }).stdout?.trim();
  if (!commit) return null;

  git(["update-ref", SHADOW_REF, commit], cwd);
  return { commit, at: new Date().toISOString(), label };
}

/** What changed since a checkpoint, as a patch. */
export function diffSince(cwd: string, commit: string): string {
  return git(["diff", commit, "--"], cwd).stdout ?? "";
}

/** Restores the working tree to a checkpoint. Destructive by intent. */
export function restore(cwd: string, commit: string): boolean {
  const indexFile = join(mkdtempSync(join(tmpdir(), "agent-restore-")), "index");
  const env = { GIT_INDEX_FILE: indexFile };
  if (git(["read-tree", commit], cwd, env).status !== 0) return false;
  return git(["checkout-index", "-a", "-f"], cwd, env).status === 0;
}

export function listCheckpoints(cwd: string): Checkpoint[] {
  if (!isGitRepo(cwd)) return [];
  const out = git(["log", SHADOW_REF, "--format=%H%x00%aI%x00%s", "-n", "20"], cwd).stdout;
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [commit, at, subject] = l.split("\0");
      return {
        commit: commit!,
        at: at!,
        label: (subject ?? "").replace(/^agent checkpoint: /, ""),
      };
    });
}
