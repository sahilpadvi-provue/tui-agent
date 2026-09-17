import type { BlastRadius, PermissionDecision } from "../core/events.ts";
import type { ToolDef } from "../tools/registry.ts";

export type PolicyOutcome =
  | { kind: "allow"; reason: string }
  | { kind: "ask" }
  | { kind: "deny"; reason: string };

export type PolicyConfig = {
  /**
   * Category rules the user sets. Nothing overrides these -- not a session
   * grant, not a classifier. The gap these fill is the documented one:
   * no way to say "never delete files" and have it stick.
   */
  readonly denyPatterns: RegExp[];
  /** Tools auto-approved regardless of arguments. */
  readonly autoAllowKinds: ReadonlySet<ToolDef["kind"]>;
};

export const DEFAULT_DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r/i, // rm -rf and friends
  /\bgit\s+(checkout|restore)\s+--?\s*\./i, // discards uncommitted work
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\b(shutdown|reboot|mkfs|dd\s+if=)/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/(sd|disk)/i,
];

/**
 * Tiered policy. Read-only tools are statically allowlisted, in-workspace
 * writes skip the prompt, and only execution reaches the user.
 *
 * This is the shape Anthropic arrived at after measuring 93% blanket approval
 * on per-call prompts. Phase 1 stops at static tiers: the model-classifier
 * layer they added on top has a documented 17% miss rate, so the deny rails
 * and the undo path come first.
 */
export class PermissionPolicy {
  constructor(
    private readonly cfg: PolicyConfig = {
      denyPatterns: DEFAULT_DENY,
      autoAllowKinds: new Set(["read", "write"]),
    },
  ) {}

  #sessionGrants = new Set<string>();

  evaluate(tool: ToolDef, radius: BlastRadius): PolicyOutcome {
    if (radius.command) {
      for (const p of this.cfg.denyPatterns) {
        if (p.test(radius.command)) {
          return { kind: "deny", reason: `blocked by deny rule ${p}` };
        }
      }
    }
    if (this.cfg.autoAllowKinds.has(tool.kind)) {
      return { kind: "allow", reason: `${tool.kind} tools are pre-approved in-workspace` };
    }
    if (this.#sessionGrants.has(tool.name)) {
      return { kind: "allow", reason: "granted for this session" };
    }
    return { kind: "ask" };
  }

  record(tool: string, decision: PermissionDecision): void {
    if (decision.kind === "allow" && decision.scope === "session") {
      this.#sessionGrants.add(tool);
    }
  }
}

/**
 * What the action will touch, one fact per line.
 *
 * Joined into a single string these wrap mid-separator and stop being
 * scannable at exactly the moment the reader is deciding whether to allow
 * something destructive.
 */
export function radiusLines(r: BlastRadius): string[] {
  const out: string[] = [];
  if (r.command) out.push(r.command);
  const effects: string[] = [];
  if (r.writes.length) effects.push(`writes ${r.writes.join(", ")}`);
  if (r.network) effects.push("network");
  if (effects.length) out.push(effects.join("  \u00b7  "));
  return out.length ? out : ["no side effects"];
}
