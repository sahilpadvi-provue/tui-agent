import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { realpathSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  CommandChunk,
  CommandResult,
  ExecOptions,
  Executor,
} from "./executor.ts";
import { WorkspaceViolation } from "./executor.ts";
import {
  detectSandbox,
  seatbeltProfile,
  wrapCommand,
  type SandboxKind,
  type SandboxPolicy,
} from "./sandbox.ts";

export type LocalExecutorOptions = {
  /** Off by default so stage 1 behaviour is unchanged; the CLI turns it on. */
  readonly sandbox?: boolean;
  readonly allowNetwork?: boolean;
};

/**
 * Local execution against the user's own working tree.
 *
 * Phase 1 enforces the workspace boundary in-process. Stage 3 adds the OS
 * sandbox underneath (Seatbelt / bwrap), which is what actually contains a
 * command that ignores us -- this check stops our own tools from wandering,
 * not a hostile subprocess.
 */
export class LocalExecutor implements Executor {
  readonly sandboxKind: SandboxKind;
  #policy: SandboxPolicy;
  #profilePath?: string;

  constructor(
    private readonly workspace: string,
    private readonly options: LocalExecutorOptions = {},
  ) {
    this.workspace = realpathSync(workspace);
    this.sandboxKind = options.sandbox === false ? "none" : detectSandbox();
    this.#policy = {
      workspace: this.workspace,
      readOnlySubpaths: [],
      allowNetwork: options.allowNetwork ?? true,
    };
    if (options.sandbox && this.sandboxKind === "seatbelt") {
      const dir = mkdtempSync(join(tmpdir(), "agent-sb-"));
      this.#profilePath = join(dir, "policy.sb");
      writeFileSync(this.#profilePath, seatbeltProfile(this.#policy));
    }
  }

  /** What the UI shows when asked how the session is contained. */
  describeSandbox(): string {
    if (!this.options.sandbox) return "off";
    if (this.sandboxKind === "none") return "unavailable on this platform";
    return `${this.sandboxKind}, network ${this.#policy.allowNetwork ? "on" : "off"}`;
  }

  /**
   * Resolve then check. Order matters: `../` and symlinks are only visible
   * after resolution, and checking the raw string is the mistake behind
   * CVE-2026-25592.
   */
  #resolve(path: string, cwd: string): string {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      // Does not exist yet: canonicalise the nearest existing parent instead,
      // so a write through a symlinked directory cannot escape.
      try {
        real = resolve(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1));
      } catch {
        /* parent missing too; fall back to the lexical resolution above */
      }
    }
    const rel = relative(this.workspace, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkspaceViolation(path, this.workspace);
    }
    return real;
  }

  async readFile(path: string, opts: ExecOptions): Promise<string> {
    return readFile(this.#resolve(path, opts.cwd), "utf8");
  }

  async writeFile(path: string, content: string, opts: ExecOptions): Promise<void> {
    const target = this.#resolve(path, opts.cwd);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async exists(path: string, opts: ExecOptions): Promise<boolean> {
    try {
      await access(this.#resolve(path, opts.cwd));
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string, opts: ExecOptions): Promise<string[]> {
    return readdir(this.#resolve(path, opts.cwd));
  }

  run(
    command: string,
    opts: ExecOptions,
    onChunk: (c: CommandChunk) => void,
  ): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      const wrapped =
        this.options.sandbox && this.#profilePath
          ? wrapCommand(command, this.#policy, this.sandboxKind, this.#profilePath)
          : null;

      // detached:true puts the child in its own process group, so killing
      // -pid takes the whole tree. Without it, Esc during `npm test` leaves
      // orphaned workers behind.
      const child = spawn(wrapped?.cmd ?? "/bin/sh", wrapped?.args ?? ["-c", command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
      });

      let killed = false;
      const killTree = () => {
        killed = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000).unref();
      };

      const timer = opts.timeoutMs
        ? setTimeout(killTree, opts.timeoutMs)
        : undefined;
      opts.signal?.addEventListener("abort", killTree, { once: true });

      child.stdout.on("data", (b: Buffer) =>
        onChunk({ kind: "stdout", text: b.toString() }),
      );
      child.stderr.on("data", (b: Buffer) =>
        onChunk({ kind: "stderr", text: b.toString() }),
      );
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ code, killed });
      });
    });
  }
}
