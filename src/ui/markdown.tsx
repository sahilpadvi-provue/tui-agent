import React, { type ReactNode } from "react";
import { Label } from "./primitives.tsx";
import type { Paint, Theme } from "../theme/index.ts";

/**
 * Inline markdown for terminal output.
 *
 * Deliberately not a parser. Models emit `**bold**`, `` `code` `` and list
 * markers constantly, and showing the raw asterisks is worse than showing
 * nothing. Block-level markdown (tables, nested lists) is out of scope until
 * something needs it.
 */

type Seg = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|(?<![*\w])\*[^*\n]+\*)/g;

export function segments(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push({ text: text.slice(last, at) });
    const t = m[0]!;
    if (t.startsWith("**")) out.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) out.push({ text: t.slice(1, -1), code: true });
    else out.push({ text: t.slice(1, -1), italic: true });
    last = at + t.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/** Heading and list markers become style, not characters. */
export function blockStyle(line: string): { text: string; bold?: boolean } {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { text: heading[2]!, bold: true };
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { text: `${bullet[1]}• ${bullet[2]}` };
  return { text: line };
}

export function Markdown({
  line,
  indent = "",
  color,
  dim,
  theme,
}: {
  line: string;
  /** Leading columns, passed in so depth stays owned by the layout system. */
  indent?: string;
  color?: Paint;
  dim?: boolean;
  theme: Theme;
}): ReactNode {
  const block = blockStyle(line);
  const segs = segments(block.text);
  return (
    <Label color={color} dim={dim} bold={block.bold}>
      {indent}
      {segs.map((s, i) => (
        <Label key={i} bold={s.bold} italic={s.italic} color={s.code ? theme.name : undefined}>
          {s.text}
        </Label>
      ))}
    </Label>
  );
}
