import { platform } from "node:os";
import { join } from "node:path";

export type SandboxPolicy = {
  /** Absolute, canonical workspace root. */
  readonly workspace: string;
  /** Paths inside the workspace that stay read-only. */
  readonly readOnlySubpaths: string[];
  readonly allowNetwork: boolean;
};

/**
 * Paths a sandboxed session must not be able to write, even inside its own
 * workspace.
 *
 * The reasoning is specific: anything here can make the NEXT launch run
 * unsandboxed. A session that can write .git/hooks plants a hook; one that can
 * write shell rc files plants a shell command. Carving them out is what stops
 * a sandbox escape from becoming persistence.
 */
export const PERSISTENCE_VECTORS = [
  ".git/hooks",
  ".git/config",
  ".mcp.json",
  ".agent/commands",
  ".agent/tools",
  ".envrc",
];

export type SandboxKind = "seatbelt" | "bubblewrap" | "none";

export function detectSandbox(): SandboxKind {
  if (platform() === "darwin") return "seatbelt";
  if (platform() === "linux") return "bubblewrap";
  return "none";
}

/**
 * Seatbelt profile, generated per session.
 *
 * Reads are deliberately unrestricted: no local sandbox on any platform can
 * restrict them, and pretending otherwise would misrepresent the boundary.
 * What this contains is writes and network egress.
 */
export function seatbeltProfile(p: SandboxPolicy): string {
  const deny = [...PERSISTENCE_VECTORS.map((v) => join(p.workspace, v)), ...p.readOnlySubpaths];
  return [
    "(version 1)",
    "(allow default)",
    "; writes: workspace only",
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(p.workspace)}))`,
    "(allow file-write* (subpath \"/private/tmp\") (subpath \"/tmp\") (subpath \"/private/var/tmp\"))",
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\"))",
    "; persistence vectors stay read-only inside the workspace",
    ...deny.map((d) => `(deny file-write* (subpath ${q(d)}))`),
    p.allowNetwork ? "" : "; network egress off\n(deny network-outbound)\n(allow network-outbound (local ip))",
  ]
    .filter(Boolean)
    .join("\n");
}

function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Wraps a command so the OS enforces the policy on it and its children. */
export function wrapCommand(
  command: string,
  policy: SandboxPolicy,
  kind: SandboxKind,
  profilePath: string,
): { cmd: string; args: string[] } | null {
  switch (kind) {
    case "seatbelt":
      return { cmd: "/usr/bin/sandbox-exec", args: ["-f", profilePath, "/bin/sh", "-c", command] };
    case "bubblewrap":
      return {
        cmd: "bwrap",
        args: [
          "--ro-bind", "/", "/",
          "--bind", policy.workspace, policy.workspace,
          ...PERSISTENCE_VECTORS.flatMap((v) => ["--ro-bind-try", join(policy.workspace, v), join(policy.workspace, v)]),
          "--bind", "/tmp", "/tmp",
          "--dev", "/dev",
          "--proc", "/proc",
          ...(policy.allowNetwork ? [] : ["--unshare-net"]),
          "--die-with-parent",
          "/bin/sh", "-c", command,
        ],
      };
    case "none":
      return null;
  }
}
