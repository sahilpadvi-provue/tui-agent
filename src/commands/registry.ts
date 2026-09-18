/**
 * Commands the user runs, as opposed to tools the model calls.
 *
 * These exist because several features -- inspecting what compaction hid,
 * putting it back, listing checkpoints -- were reachable only from a separate
 * CLI, in another terminal, after quitting. A differentiator you have to leave
 * the app to use is not one.
 *
 * A command never touches the UI. It returns text, and the caller decides how
 * that reaches a screen.
 *
 * `run` is async even though most of these answer from memory. Several are
 * local only until the gateway exists -- /model has to ask it which models
 * exist, and /sessions moves server-side the moment sessions sync -- and
 * changing the signature once there are eight implementations of it means
 * touching all of them and every call site.
 */
import type { AgentEvent } from "../core/events.ts";
import { project } from "../core/projection.ts";
import { listSessions } from "../core/session.ts";
import { THEMES, themeNamed, type Theme, type ThemeId } from "../theme/index.ts";
import { listCheckpoints } from "../exec/checkpoint.ts";

export type CommandContext = {
  readonly sessionId: string;
  readonly cwd: string;
  /** Everything recorded so far, for commands that report on the session. */
  readonly history: AgentEvent[];
  readonly model: string;
  /** Replaces the model for subsequent turns. */
  setModel(name: string): void;
  /**
   * What the backend offers. Ollama answers this today; the gateway will,
   * once it exists. The client never holds a hardcoded list.
   */
  availableModels(): Promise<string[]>;
  /** Starts a fresh conversation, keeping the session's log. */
  clear(): void;
  /** Un-hides compacted events. */
  restore(seqs: number[]): void;
  /**
   * Switches this client to another session: its log, its sequence and its
   * transcript, in one step. Throws with a readable message if the id is
   * unknown or the session was recorded against a different workspace.
   */
  resume(sessionId: string): void;
  /** Which theme is showing, and how to change it. */
  readonly theme: ThemeId;
  setTheme(theme: Theme): void;
};

export type CommandResult = { ok: boolean; output: string };

export type Command = {
  readonly name: string;
  readonly takes?: string;
  readonly summary: string;
  run(rest: string, ctx: CommandContext): Promise<CommandResult>;
};

const help: Command = {
  name: "help",
  summary: "list these commands",
  run: async () => ({
    ok: true,
    output: COMMANDS.map((c) => {
      const usage = `/${c.name}${c.takes ? ` ${c.takes}` : ""}`;
      return `  ${usage.padEnd(20)} ${c.summary}`;
    }).join("\n"),
  }),
};

const context: Command = {
  name: "context",
  summary: "what compaction hid, and how to put it back",
  run: async (_rest, ctx) => {
    const { messages, dropped } = project(ctx.history);
    if (dropped.length === 0) {
      return { ok: true, output: `${messages.length} messages in context, nothing compacted yet` };
    }
    const lines = [`${messages.length} messages in context, ${dropped.length} compaction(s)`];
    for (const d of dropped) {
      const stillHidden = d.seqs.filter((s) => !messages.some((m) => m.seq === s));
      lines.push(
        `  hid ${d.seqs.length} events (${stillHidden.length} still hidden) — ${d.reason}`,
        `    ${d.summary}`,
        `    /restore ${stillHidden.join(",") || "(nothing hidden)"}`,
      );
    }
    return { ok: true, output: lines.join("\n") };
  },
};

const restore: Command = {
  name: "restore",
  takes: "<seqs>",
  summary: "put compacted events back into context",
  run: async (rest, ctx) => {
    const seqs = rest.split(/[,\s]+/).map(Number).filter(Number.isFinite);
    if (seqs.length === 0) {
      return { ok: false, output: "usage: /restore 265,266   (see /context for the numbers)" };
    }
    ctx.restore(seqs);
    return { ok: true, output: `restored ${seqs.length} event(s) into context` };
  },
};

const sessions: Command = {
  name: "sessions",
  summary: "sessions recorded in this workspace",
  run: async () => {
    const found = listSessions();
    if (found.length === 0) return { ok: true, output: "no sessions yet" };
    return {
      ok: true,
      output: found
        .slice(0, 10)
        .map((s) => `  ${s.id}  ${s.lastAt.slice(0, 16).replace("T", " ")}  ${s.firstPrompt.slice(0, 44)}`)
        .join("\n"),
    };
  },
};

const resumeCmd: Command = {
  name: "resume",
  takes: "<id>",
  summary: "continue an earlier session",
  run: async (rest, ctx) => {
    const id = rest.trim();
    // No id is not an error: the composer shows the session list while the
    // argument is empty, so reaching here means the list was dismissed.
    if (!id) return { ok: false, output: "usage: /resume <id>   (see /sessions)" };
    if (id === ctx.sessionId) return { ok: true, output: `already in ${id}` };
    try {
      ctx.resume(id);
    } catch (e) {
      return { ok: false, output: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, output: `resumed ${id}` };
  },
};

const themeCmd: Command = {
  name: "theme",
  takes: "[dark|light]",
  summary: "switch between the built-in themes",
  run: async (rest, ctx) => {
    const wanted = rest.trim();
    // With no argument it says what there is and which one is showing, rather
    // than failing at someone who has forgotten the names.
    if (!wanted) {
      return {
        ok: true,
        output: THEMES.map((t) => `  ${t.id === ctx.theme ? "\u203a" : " "} ${t.id}`).join("\n"),
      };
    }
    const found = themeNamed(wanted);
    if (!found) {
      return { ok: false, output: `no theme "${wanted}". There is ${THEMES.map((t) => t.id).join(" and ")}.` };
    }
    ctx.setTheme(found);
    return { ok: true, output: `theme is ${found.id}` };
  },
};

const checkpoints: Command = {
  name: "checkpoints",
  summary: "git snapshots taken before edits",
  run: async (_rest, ctx) => {
    const found = listCheckpoints(ctx.cwd);
    if (found.length === 0) return { ok: true, output: "none — not a git repo, or no edits yet" };
    return {
      ok: true,
      output: [
        ...found.slice(0, 10).map((c) => `  ${c.commit.slice(0, 8)}  ${c.at.slice(0, 16).replace("T", " ")}  ${c.label}`),
        "",
        "  recover a file:  git show <commit>:<path>",
      ].join("\n"),
    };
  },
};

const model: Command = {
  name: "model",
  takes: "[name]",
  summary: "show or switch the model",
  run: async (rest, ctx) => {
    const next = rest.trim();
    if (!next) {
      const offered = await ctx.availableModels().catch(() => []);
      const list = offered.length
        ? offered.map((m) => `  ${m === ctx.model ? "\u2022" : " "} ${m}`).join("\n")
        : "  (could not reach the backend for a list)";
      return { ok: true, output: `${list}\n\n  /model <name> to switch` };
    }
    ctx.setModel(next);
    // Earlier turns were produced under the previous model, and some providers
    // tie reasoning blocks to the model that made them. Saying so is cheaper
    // than a confusing failure two turns later.
    return {
      ok: true,
      output: `model is now ${next}\n  earlier turns in this session were produced by ${ctx.model}`,
    };
  },
};

const clear: Command = {
  name: "clear",
  summary: "start a fresh conversation in this session",
  run: async (_rest, ctx) => {
    ctx.clear();
    return { ok: true, output: "context cleared — the log keeps everything" };
  },
};

export const COMMANDS: Command[] = [
  help, context, restore, sessions, resumeCmd, checkpoints, model, themeCmd, clear,
];

export function isCommand(input: string): boolean {
  const text = input.trimStart();
  if (!text.startsWith("/")) return false;
  // An absolute path also starts with a slash, and asking about one is an
  // ordinary thing to do -- so the first word decides. A command is named by
  // a bare word; a path carries a separator or an extension. Getting this
  // wrong is silent in the worst way: "/src/ui/layout.ts what does STEP do"
  // was answered with `unknown command` and never reached the model.
  //
  // A name that matches nothing still runs, so a typo is told it is a typo
  // rather than being handed to the model as a question.
  const word = text.slice(1).split(/\s/)[0] ?? "";
  return word !== "" && !word.includes("/") && !word.includes(".");
}

/** Splits "/restore 1,2" into its name and the rest. */
export function parseCommand(input: string): { name: string; rest: string } {
  const trimmed = input.trim().slice(1);
  const space = trimmed.indexOf(" ");
  return space === -1
    ? { name: trimmed, rest: "" }
    : { name: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

export async function runCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult & { name: string; rest: string }> {
  const { name, rest } = parseCommand(input);
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    const known = COMMANDS.map((c) => `/${c.name}`).join(" ");
    return { name, rest, ok: false, output: `unknown command "/${name}"\n  try: ${known}` };
  }
  return { name, rest, ...(await command.run(rest, ctx)) };
}
