import type { Executor, ExecOptions } from "../exec/executor.ts";
import type { BlastRadius } from "../core/events.ts";

export type ToolContext = {
  readonly exec: Executor;
  readonly opts: ExecOptions;
  /** Streams incremental output (command stdout/stderr) to the bus. */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Files read during this session.
   *
   * Weak models edit files they have never opened, inventing the text they
   * claim to be replacing. The system prompt asks them not to; this makes it
   * an invariant the harness enforces rather than a request the model may
   * ignore.
   */
  readonly readFiles?: Set<string>;
};

export type ToolDef<A = any> = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, sent to the model verbatim. */
  readonly parameters: Record<string, unknown>;
  /** Cheap, side-effect free classification used by the permission policy. */
  readonly kind: "read" | "write" | "execute";
  /** Validates and narrows model-supplied arguments. Throws on bad input. */
  validate(raw: unknown): A;
  /** What this call would touch, computed before it runs. */
  blastRadius(args: A, ctx: ToolContext): BlastRadius;
  run(args: A, ctx: ToolContext): Promise<string>;
};

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.#tools.values()];
  }

  /** The tool list as the model wire format expects it. */
  schemas(): unknown[] {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

/** Raised for malformed model output. Returned to the model, never fatal. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export function str(raw: unknown, field: string): string {
  const v = (raw as Record<string, unknown>)?.[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolArgumentError(`"${field}" must be a non-empty string`);
  }
  return v;
}

export function optStr(raw: unknown, field: string): string | undefined {
  const v = (raw as Record<string, unknown>)?.[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new ToolArgumentError(`"${field}" must be a string`);
  }
  return v;
}
