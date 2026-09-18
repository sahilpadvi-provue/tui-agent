/**
 * The renderer contract.
 *
 * `primitives.tsx` is the surface the UI is written against; this is the
 * surface a renderer has to satisfy to sit behind it. Splitting the two is
 * what turns "replacing Ink cost one file" into a property of the design
 * rather than a fact about one afternoon: the file that changes is a backend,
 * and the one the UI imports does not move.
 *
 * The vocabulary types live here rather than in a backend because both
 * backends and the layout system need them, and a shared type owned by one
 * implementation is the first thing to leak when a second one arrives.
 *
 * Deliberately two elements. `App` renders 43 `Label`s, 9 `Stack`s and one
 * `Settled` and nothing else, so a box and a run of styled text is the whole
 * host surface a terminal renderer has to provide.
 */

import type { ComponentType, ReactNode } from "react";
import type { Paint } from "../theme/index.ts";

export type Color =
  | "black" | "red" | "green" | "yellow" | "blue"
  | "magenta" | "cyan" | "white" | "gray" | "grey";

/**
 * A subset, and the subset is the contract: these are the keys `App` reads.
 * Ink's own `Key` is a superset, so an Ink backend satisfies this by
 * structural assignment rather than by translation.
 */
export type Key = {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  escape: boolean;
  return: boolean;
  backspace: boolean;
  delete: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  tab: boolean;
  home: boolean;
  end: boolean;
};

export type KeyEvent = { char: string; key: Key };

export type BoxProps = {
  children?: ReactNode;
  direction?: "row" | "column";
  padX?: number;
  /** A rule above and below, not a full box. */
  border?: boolean;
  borderColor?: Paint;
  borderDim?: boolean;
  /** "between" pushes the last child to the right edge. */
  align?: "start" | "end" | "between";
};

export type TextProps = {
  children?: ReactNode;
  color?: Paint;
  bg?: Paint;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
};

export type SettledProps<T> = {
  items: T[];
  render: (item: T, index: number) => ReactNode;
};

export type Instance = {
  rerender: (node: ReactNode) => void;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
};

export type MountOptions = {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Called once per frame actually written. `scripts/bench.tsx` counts them. */
  onRender?: () => void;
};

export type Backend = {
  readonly name: string;
  readonly Box: ComponentType<BoxProps>;
  readonly Text: ComponentType<TextProps>;
  /**
   * Output that can no longer change.
   *
   * Not decoration: under Ink this is `Static`, which prints once and will not
   * reprint, while the cell renderer keeps every row in its grid and simply
   * declines to address the ones above the viewport. Same guarantee, opposite
   * mechanism, which is exactly the kind of thing a backend has to own.
   *
   * It must be the tree's first child. `Static` prepends its output to the
   * frame rather than placing it in tree order, so anywhere else the two
   * backends draw different screens. `scripts/backend-check.tsx` asserts both
   * that they agree with it first and that they disagree with it elsewhere,
   * so the rule cannot be dropped as arbitrary.
   */
  readonly Settled: <T>(props: SettledProps<T>) => ReactNode;
  mount(node: ReactNode, options: MountOptions): Instance;
  useKeys(fn: (char: string, key: Key) => void): void;
  usePaste(fn: (text: string) => void): void;
  useColumns(): number;
  useExit(): () => void;
  /**
   * One frame as plain rows, no escapes and no terminal.
   *
   * Two renderers cannot be compared on their bytes -- one writes a cell diff,
   * the other a reflowed string -- so this is the only place a backend can be
   * held to the same answer as another. `scripts/backend-check.tsx` is that
   * comparison, over a synthetic tree and over the real `App`.
   *
   * It does not replace a backend's own gates. `colour:check` and `md:check`
   * assert on the escapes the cell renderer emits, which is exactly what this
   * strips, and they are right to test one backend's bytes directly.
   */
  renderToText(node: ReactNode, columns: number): string[];
};
