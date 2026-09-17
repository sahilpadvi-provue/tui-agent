/**
 * Whitespace-tolerant matching for edit_file.
 *
 * Weaker models reliably collapse multi-line source into one line when
 * echoing it back. Exact-match-only editing turns that into a dead end: the
 * model re-reads the file, produces the same flattened string, and burns the
 * failure budget. Tolerating whitespace differences -- but only when the
 * match is still unique -- converts a hard failure into a correct edit
 * without inviting an ambiguous one.
 */

export type MatchResult =
  | { kind: "exact"; start: number; end: number }
  | { kind: "whitespace"; start: number; end: number }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

/** Collapses whitespace runs, keeping a map back to original offsets. */
function normalise(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (!inSpace && text.length > 0) {
        text += " ";
        map.push(i);
      }
      inSpace = true;
    } else {
      text += c;
      map.push(i);
      inSpace = false;
    }
  }
  return { text: text.trimEnd(), map };
}

export function findMatch(haystack: string, needle: string): MatchResult {
  const exactCount = haystack.split(needle).length - 1;
  if (exactCount === 1) {
    const start = haystack.indexOf(needle);
    return { kind: "exact", start, end: start + needle.length };
  }
  if (exactCount > 1) return { kind: "ambiguous", count: exactCount };

  const h = normalise(haystack);
  const n = normalise(needle);
  if (n.text.length === 0) return { kind: "none" };

  const count = h.text.split(n.text).length - 1;
  if (count === 0) return { kind: "none" };
  if (count > 1) return { kind: "ambiguous", count };

  const at = h.text.indexOf(n.text);
  const start = h.map[at]!;
  const lastIdx = at + n.text.length - 1;
  const end = (h.map[lastIdx] ?? start) + 1;
  return { kind: "whitespace", start, end };
}

/** A few lines of real file content, so the model can correct itself. */
export function contextSnippet(content: string, max = 1200): string {
  return content.length <= max
    ? content
    : content.slice(0, max) + `\n... [${content.length - max} more chars]`;
}
