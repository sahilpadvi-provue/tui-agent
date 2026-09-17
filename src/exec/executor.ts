/**
 * The execution boundary.
 *
 * Async and stream-shaped even though the local implementation does not need
 * to be: the container implementation (phase 2) speaks HTTP, and any
 * synchronous signature here would have to change every caller to admit it.
 * Command output streams for the same reason -- a test suite emits output for
 * minutes and the user needs to watch it arrive.
 */

export type ExecOptions = {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type CommandChunk =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string };

export type CommandResult = {
  readonly code: number | null;
  readonly killed: boolean;
};

export interface Executor {
  readFile(path: string, opts: ExecOptions): Promise<string>;
  writeFile(path: string, content: string, opts: ExecOptions): Promise<void>;
  exists(path: string, opts: ExecOptions): Promise<boolean>;
  list(path: string, opts: ExecOptions): Promise<string[]>;

  /**
   * Runs a command, streaming output as it arrives. The returned promise
   * resolves only once the process tree has exited.
   */
  run(
    command: string,
    opts: ExecOptions,
    onChunk: (c: CommandChunk) => void,
  ): Promise<CommandResult>;
}

/** Thrown when a path escapes the workspace. Never caught by the loop. */
export class WorkspaceViolation extends Error {
  constructor(readonly attempted: string, readonly workspace: string) {
    super(`path escapes workspace: ${attempted} is outside ${workspace}`);
    this.name = "WorkspaceViolation";
  }
}
