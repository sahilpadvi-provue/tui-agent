/**
 * Does what was just written actually parse?
 *
 * A model that writes broken code and is told "ok" has no reason to look
 * again -- observed: qwen3:8b wrote three unterminated string literals into a
 * file, received a success result, and stopped. The cheapest moment to catch
 * that is the write itself, in the result the model reads next.
 *
 * This warns rather than refuses. An intermediate state that does not parse
 * is legitimate mid-edit, and a tool that rejects writes would be worse than
 * one that reports them.
 */

const LOADERS: Record<string, "js" | "jsx" | "ts" | "tsx"> = {
  js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
};

export function syntaxError(path: string, content: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const loader = LOADERS[ext];
  if (!loader) return null;

  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return null;
  } catch (err) {
    const message = (err as Error).message.split("\n")[0] ?? String(err);
    return message.trim();
  }
}

/** Appends the warning to a tool result, when there is one. */
export function withSyntaxCheck(result: string, path: string, content: string): string {
  const problem = syntaxError(path, content);
  return problem
    ? `${result}\n\nWARNING: ${path} does not parse after this edit — ${problem}\nRead the file and fix it before doing anything else.`
    : result;
}
