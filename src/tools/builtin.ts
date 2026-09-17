import { resolve } from "node:path";
import type { ToolDef, ToolContext } from "./registry.ts";
import { ToolArgumentError, str, optStr } from "./registry.ts";
import { findMatch, contextSnippet } from "./fuzzy.ts";
import { withSyntaxCheck } from "./syntax.ts";

const MAX_OUTPUT = 30_000;

/** Bounded so a 10MB test log never reaches the model or the screen. */
function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT} chars truncated] ...\n\n${s.slice(-half)}`;
}

export const readFileTool: ToolDef<{ path: string }> = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Output is line-numbered as 'N| text'. " +
    "Use those line numbers with replace_lines.",
  kind: "read",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string", description: "Path relative to the workspace root" } },
    required: ["path"],
  },
  validate: (raw) => ({ path: str(raw, "path") }),
  blastRadius: () => ({ writes: [], network: false }),
  run: async (a, ctx) => {
    const content = await ctx.exec.readFile(a.path, ctx.opts);
    ctx.readFiles?.add(normalisePath(a.path));
    return cap(number(content));
  },
};

export const writeFileTool: ToolDef<{ path: string; content: string }> = {
  name: "write_file",
  description: "Create or overwrite a file in the workspace.",
  kind: "write",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  validate: (raw) => ({ path: str(raw, "path"), content: str(raw, "content") }),
  blastRadius: (a, ctx) => ({ writes: [resolve(ctx.opts.cwd, a.path)], network: false }),
  run: async (a, ctx) => {
    await ctx.exec.writeFile(a.path, a.content, ctx.opts);
    return withSyntaxCheck(`wrote ${a.path} (${a.content.length} bytes)`, a.path, a.content);
  },
};

export const editFileTool: ToolDef<{ path: string; old: string; new: string }> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. The old string must appear exactly once.",
  kind: "write",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      old: { type: "string", description: "Exact text to replace" },
      new: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old", "new"],
  },
  validate: (raw) => ({
    path: str(raw, "path"),
    old: str(raw, "old"),
    new: optStr(raw, "new") ?? "",
  }),
  blastRadius: (a, ctx) => ({ writes: [resolve(ctx.opts.cwd, a.path)], network: false }),
  run: async (a, ctx) => {
    if (ctx.readFiles && !ctx.readFiles.has(normalisePath(a.path))) {
      throw new ToolArgumentError(
        `read ${a.path} before editing it — call read_file first, then copy the exact text you want to replace`,
      );
    }
    const before = await ctx.exec.readFile(a.path, ctx.opts);
    const m = findMatch(before, a.old);

    if (m.kind === "ambiguous") {
      throw new ToolArgumentError(
        `"old" matches ${m.count} places in ${a.path}; include more surrounding lines to make it unique`,
      );
    }
    if (m.kind === "none") {
      // The error carries the file so the model can correct itself rather
      // than guessing again at the same wrong string.
      throw new ToolArgumentError(
        `"old" not found in ${a.path}. The file currently contains:\n\n${contextSnippet(before)}\n\nCopy the exact text you want to replace from the content above.`,
      );
    }

    const after = before.slice(0, m.start) + a.new + before.slice(m.end);
    await ctx.exec.writeFile(a.path, after, ctx.opts);
    const note = m.kind === "whitespace"
      ? `edited ${a.path} (matched ignoring whitespace differences)`
      : `edited ${a.path}`;
    return withSyntaxCheck(note, a.path, after);
  },
};

/**
 * Line-addressed editing.
 *
 * edit_file requires the model to reproduce existing text byte-for-byte.
 * Smaller models cannot do that reliably -- observed failure: qwen3:8b read a
 * file containing `split(",")` and edited with `split(\',\')`, twice, after
 * being shown the file. Addressing lines by number removes transcription from
 * the critical path entirely: the model only has to count.
 */
export const replaceLinesTool: ToolDef<{
  path: string;
  start_line: number;
  end_line: number;
  content: string;
}> = {
  name: "replace_lines",
  description:
    "Replace an inclusive range of lines in a file with new text. Line numbers " +
    "come from read_file output. Prefer this over edit_file.",
  kind: "write",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      start_line: { type: "number", description: "First line to replace (1-based, inclusive)" },
      end_line: { type: "number", description: "Last line to replace (1-based, inclusive)" },
      content: { type: "string", description: "Replacement text, without line numbers" },
    },
    required: ["path", "start_line", "end_line", "content"],
  },
  validate: (raw) => {
    const r = raw as Record<string, unknown>;
    const start = Number(r?.start_line);
    const end = Number(r?.end_line);
    if (!Number.isInteger(start) || start < 1) {
      throw new ToolArgumentError(`"start_line" must be a positive integer`);
    }
    if (!Number.isInteger(end) || end < start) {
      throw new ToolArgumentError(`"end_line" must be an integer >= start_line`);
    }
    return {
      path: str(raw, "path"),
      start_line: start,
      end_line: end,
      content: optStr(raw, "content") ?? "",
    };
  },
  blastRadius: (a, ctx) => ({ writes: [resolve(ctx.opts.cwd, a.path)], network: false }),
  run: async (a, ctx) => {
    if (ctx.readFiles && !ctx.readFiles.has(normalisePath(a.path))) {
      throw new ToolArgumentError(`read ${a.path} before editing it — call read_file first`);
    }
    const before = await ctx.exec.readFile(a.path, ctx.opts);
    const lines = before.split("\n");
    if (a.start_line > lines.length) {
      throw new ToolArgumentError(
        `${a.path} has ${lines.length} lines; start_line ${a.start_line} is past the end`,
      );
    }
    const end = Math.min(a.end_line, lines.length);
    const replacement = a.content === "" ? [] : a.content.split("\n");
    const after = [...lines.slice(0, a.start_line - 1), ...replacement, ...lines.slice(end)];
    const text = after.join("\n");
    await ctx.exec.writeFile(a.path, text, ctx.opts);
    return withSyntaxCheck(
      `replaced lines ${a.start_line}-${end} of ${a.path} (${end - a.start_line + 1} -> ${replacement.length} lines)`,
      a.path,
      text,
    );
  },
};

export const listFilesTool: ToolDef<{ path?: string }> = {
  name: "list_files",
  description: "List directory entries in the workspace.",
  kind: "read",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string", description: "Defaults to the workspace root" } },
  },
  validate: (raw) => ({ path: optStr(raw, "path") ?? "." }),
  blastRadius: () => ({ writes: [], network: false }),
  run: async (a, ctx) => (await ctx.exec.list(a.path ?? ".", ctx.opts)).join("\n"),
};

export const searchTool: ToolDef<{ pattern: string; path?: string }> = {
  name: "search",
  description: "Search file contents with a regular expression.",
  kind: "read",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search; defaults to workspace root" },
    },
    required: ["pattern"],
  },
  validate: (raw) => ({ pattern: str(raw, "pattern"), path: optStr(raw, "path") }),
  blastRadius: () => ({ writes: [], network: false }),
  run: async (a, ctx) => {
    let out = "";
    const dir = a.path ?? ".";
    // grep -r over a quoted pattern; the executor still bounds the cwd.
    await ctx.exec.run(
      `grep -rn --exclude-dir=node_modules --exclude-dir=.git -- ${shellQuote(a.pattern)} ${shellQuote(dir)} | head -100`,
      ctx.opts,
      (c) => {
        out += c.text;
      },
    );
    return cap(out || "no matches");
  },
};

export const shellTool: ToolDef<{ command: string }> = {
  name: "shell",
  description: "Run a shell command in the workspace and return its output.",
  kind: "execute",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  validate: (raw) => ({ command: str(raw, "command") }),
  blastRadius: (a, ctx) => ({
    writes: [ctx.opts.cwd],
    network: true,
    command: a.command,
  }),
  run: async (a, ctx) => {
    let out = "";
    const res = await ctx.exec.run(a.command, { ...ctx.opts, timeoutMs: 120_000 }, (c) => {
      out += c.text;
      ctx.onOutput?.(c.kind, c.text);
    });
    const status = res.killed
      ? "[cancelled]"
      : `[exit ${res.code}]`;
    return cap(`${out}${status}`);
  },
};

/** Line numbers make replace_lines addressable without transcription. */
function number(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n");
}

/** "./src/x.ts" and "src/x.ts" are the same file to the model. */
function normalisePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const builtinTools = [
  readFileTool,
  writeFileTool,
  replaceLinesTool,
  editFileTool,
  listFilesTool,
  searchTool,
  shellTool,
] as ToolDef[];
