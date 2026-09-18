import React, { type ReactNode } from "react";
import { Label } from "./primitives.tsx";
import { displayWidth, sliceToWidth, wrap, type Line, type Span } from "./layout.ts";
import type { Paint, Theme } from "../theme/index.ts";

/**
 * Markdown for terminal output.
 *
 * Deliberately not a parser. Models emit `**bold**`, `` `code` ``, links and
 * list markers constantly, and showing the raw markers is worse than showing
 * nothing.
 *
 * One block construct: the table. A comparison is the shape a model reaches
 * for whenever it is asked to weigh options, and rendered as raw pipes it is
 * the least readable thing on the screen -- the rows run into each other and
 * the columns are only findable by counting. It is the one case where the
 * layout has to see a whole block before it can place any row of it, which is
 * why it produces `Line[]` here rather than being a component.
 *
 * Nested lists are still out of scope.
 */

type Seg = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^)\s]+\)|(?<![*\w])\*[^*\n]+\*)/g;

export function segments(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push({ text: text.slice(last, at) });
    const t = m[0]!;
    if (t.startsWith("**")) out.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) out.push({ text: t.slice(1, -1), code: true });
    else if (t.startsWith("[")) {
      // The label alone is a dead end in a terminal: there is nothing to
      // click and no way to recover the address. Both, and the address is
      // what you actually need.
      const cut = t.indexOf("](");
      const href = t.slice(cut + 2, -1);
      out.push({ text: t.slice(1, cut), code: true, href });
      out.push({ text: ` (${href})`, code: true, href });
    }
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

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type Table = { readonly head: readonly string[]; readonly rows: readonly string[][] };
export type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "table"; readonly table: Table };

const ROW = /^\s*\|(.+)\|\s*$/;
const DIVIDER = /^[\s|:-]+$/;

const cells = (line: string): string[] =>
  (ROW.exec(line)?.[1] ?? "").split("|").map((c) => c.trim());

/**
 * Prose and tables, in order.
 *
 * A table needs at least a header and its divider to be one; two pipes in a
 * sentence are not a table, and guessing wrong turns a paragraph into a grid.
 */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push({ kind: "text", text: prose.join("\n") });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (ROW.test(line) && next !== undefined && ROW.test(next) && DIVIDER.test(next)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && ROW.test(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push({ kind: "table", table: { head, rows } });
      continue;
    }
    prose.push(line);
  }
  flush();
  return out;
}

/** Two spaces of breathing room each side of the divider, as a cell would have. */
const GAP = 3;
const MIN_COLUMN = 8;

/**
 * Column widths that fit, preferring to take room from whoever has most.
 *
 * Shrinking every column by the same proportion is what produces a table with
 * one unreadable column of single words beside three roomy ones: the widest
 * column is usually prose and the narrowest is usually a name, and the name
 * cannot afford to lose anything.
 */
function widths(t: Table, total: number): number[] {
  const natural = t.head.map((h, c) =>
    Math.max(displayWidth(h), ...t.rows.map((r) => displayWidth(r[c] ?? ""))),
  );
  const available = total - GAP * (natural.length - 1);
  let over = natural.reduce((a, b) => a + b, 0) - available;
  if (over <= 0) return natural;

  const out = [...natural];
  while (over > 0) {
    const widest = out.indexOf(Math.max(...out));
    if (out[widest]! <= MIN_COLUMN) break;
    out[widest] = out[widest]! - 1;
    over--;
  }
  return out;
}

/** Pads a run of spans out to a column, so the divider after it lines up. */
function pad(spans: Span[], to: number): Span[] {
  const short = to - spans.reduce((n, s) => n + displayWidth(s.text), 0);
  return short > 0 ? [...spans, { text: " ".repeat(short) }] : spans;
}

/**
 * A table as rows of spans.
 *
 * Cells wrap inside their column, so a row is as tall as its tallest cell and
 * the dividers run the whole height of it. The header is weight and not
 * colour: every colour on this screen already means something, and "this is a
 * heading" is not one of them.
 */
export function tableLines(t: Table, width: number, depth: number, theme: Theme): Line[] {
  const cols = widths(t, width);
  const divider: Span = { text: " │ ", color: theme.muted, dim: true };

  const rowLines = (row: readonly string[], bold: boolean): Line[] => {
    const wrapped = cols.map((w, c) => wrapSpans(row[c] ?? "", w, theme));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    return Array.from({ length: height }, (_, n) => {
      const spans: Span[] = [];
      cols.forEach((w, c) => {
        if (c > 0) spans.push(divider);
        const cell = wrapped[c]?.[n] ?? [];
        spans.push(...pad(bold ? cell.map((s) => ({ ...s, bold: true })) : cell, w));
      });
      return { text: spans.map((s) => s.text).join(""), spans, depth };
    });
  };

  const rule = (): Line => {
    const spans: Span[] = [];
    cols.forEach((w, c) => {
      if (c > 0) spans.push(divider);
      spans.push({ text: "─".repeat(w), color: theme.muted, dim: true });
    });
    return { text: spans.map((s) => s.text).join(""), spans, depth };
  };

  const out: Line[] = [...rowLines(t.head, true), rule()];
  t.rows.forEach((r, i) => {
    if (i > 0) out.push(rule());
    out.push(...rowLines(r, false));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Wrapping styled text
// ---------------------------------------------------------------------------

type Styled = Omit<Span, "text">;

const sameStyle = (a: Styled, b: Styled): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.color === b.color
  && a.underline === b.underline;

/**
 * Wrap first, then parse, and `**a long phrase**` split across the break
 * renders as raw asterisks with no emphasis on either line -- which is what
 * happened here until this existed. Markers have to be resolved before the
 * text is broken, so the break happens between styled words rather than
 * through a marker pair.
 *
 * Mirrors `wrap`'s treatment of blank rows on purpose: leading and trailing
 * ones dropped, runs collapsed to one, so the rhythm belongs to the layout and
 * not to however many newlines a model happened to emit.
 */
export function wrapSpans(text: string, width: number, theme: Theme): Span[][] {
  const out: Span[][] = [];
  let pendingBlank = false;

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") {
      if (out.length > 0) pendingBlank = true;
      continue;
    }
    if (pendingBlank) out.push([]);
    pendingBlank = false;

    const block = blockStyle(raw);
    const tokens: { text: string; style: Styled }[] = [];
    for (const seg of segments(block.text)) {
      const style: Styled = {
        bold: seg.bold || block.bold,
        italic: seg.italic,
        // A link that looks like prose is not discoverable, which is the
        // whole job of a link. Underline is the one attribute reliable
        // enough to carry it.
        ...(seg.href ? { underline: true } : {}),
        ...(seg.code ? { color: theme.name } : {}),
      };
      for (const word of seg.text.split(/(\s+)/)) if (word) tokens.push({ text: word, style });
    }

    let line: { text: string; style: Styled }[] = [];
    let used = 0;
    const flush = () => {
      while (line.length && line[line.length - 1]!.text.trim() === "") line.pop();
      if (line.length) out.push(merge(line));
      line = [];
      used = 0;
    };
    for (const token of tokens) {
      let text = token.text;
      const blank = text.trim() === "";
      if (!blank && displayWidth(text) + used > width && used > 0) flush();
      if (blank && used === 0) continue;
      // A URL is one token and is routinely wider than a table column. Left
      // whole it overflows the column and shears every row after it, so it
      // breaks -- the same choice `wrap` makes for an over-long word.
      while (!blank && displayWidth(text) > width) {
        const head = sliceToWidth(text, width - used);
        if (head === "") break;
        line.push({ text: head, style: token.style });
        text = text.slice(head.length);
        flush();
      }
      if (text === "") continue;
      line.push({ text, style: token.style });
      used += displayWidth(text);
    }
    flush();
  }
  return out;
}

function merge(tokens: { text: string; style: Styled }[]): Span[] {
  const out: Span[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, t.style)) out[out.length - 1] = { ...last, text: last.text + t.text };
    else out.push({ text: t.text, ...t.style });
  }
  return out;
}
