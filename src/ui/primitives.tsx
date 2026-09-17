/**
 * The ONLY module that imports Ink.
 *
 * Every screen is written against these components, so replacing the
 * renderer (OpenTUI, or a fork) is a rewrite of this file rather than of
 * the UI. That property is the reason the Ink decision is reversible, and
 * it survives only if nothing else imports "ink" directly.
 */
import React, { type ReactNode, type RefObject } from "react";
import {
  Box as InkBox,
  Text as InkText,
  Static as InkStatic,
  useInput as inkUseInput,
  useApp as inkUseApp,
  useStdout as inkUseStdout,
  useBoxMetrics as inkUseBoxMetrics,
  render as inkRender,
  type DOMElement,
} from "ink";

export type Color =
  | "black" | "red" | "green" | "yellow" | "blue"
  | "magenta" | "cyan" | "white" | "gray" | "grey";

export type StackProps = {
  children?: ReactNode;
  direction?: "row" | "column";
  gap?: number;
  padX?: number;
  padY?: number;
  width?: number | string;
  height?: number;
  grow?: number;
  shrink?: number;
  clip?: boolean;
  /** Push children along the main axis. "between" splits left and right. */
  align?: "start" | "end" | "between";
  border?: boolean;
  /** Which edges the border draws. Defaults to all four. */
  borderSides?: "all" | "y";
  borderColor?: Color;
  borderDim?: boolean;
  ref?: RefObject<DOMElement | null>;
};

export function Stack({
  children, direction = "column", gap, padX, padY, width, height,
  grow, shrink, clip, align, border, borderSides = "all", borderColor, borderDim, ref,
}: StackProps) {
  return (
    <InkBox
      ref={ref}
      flexDirection={direction}
      gap={gap}
      paddingX={padX}
      paddingY={padY}
      width={width}
      height={height}
      flexGrow={grow}
      flexShrink={shrink}
      justifyContent={
        align === "end" ? "flex-end" : align === "between" ? "space-between" : undefined
      }
      overflowY={clip ? "hidden" : undefined}
      borderStyle={border ? "round" : undefined}
      borderLeft={border && borderSides === "all"}
      borderRight={border && borderSides === "all"}
      borderColor={borderColor}
      borderDimColor={borderDim}
    >
      {children}
    </InkBox>
  );
}

export type LabelProps = {
  children?: ReactNode;
  color?: Color | string;
  /** Fills the run's cells. Used to band a whole row, never for emphasis. */
  bg?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-end";
};

export function Label({ children, color, bg, dim, bold, italic, wrap }: LabelProps) {
  return (
    <InkText color={color} backgroundColor={bg} dimColor={dim} bold={bold} italic={italic} wrap={wrap}>
      {children}
    </InkText>
  );
}

/**
 * Append-only region. Items handed to it are printed once and never
 * re-rendered, so a long transcript costs nothing per frame and lands in the
 * terminal's real scrollback. Only ever append to `items`; mutating or
 * re-keying it reprints everything, which is the documented way agent TUIs
 * collapse at scale.
 */
export function Settled<T>({
  items,
  render,
}: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
}) {
  return <InkStatic items={items}>{(item, i) => render(item, i)}</InkStatic>;
}

export const useKeys = inkUseInput;
export const useApp = inkUseApp;
export const useStdout = inkUseStdout;
export const useMetrics = inkUseBoxMetrics;
export type { DOMElement };

export function mount(node: ReactNode) {
  return inkRender(node, {
    // Inline, not alternate screen: settled output belongs in the user's own
    // scrollback, where they can scroll, search and copy it with the terminal
    // they already know. The cost is ink#907 (ghost lines when the terminal
    // narrows) -- accepted, because an app that owns the whole screen cannot
    // hand its history back.
    incrementalRendering: true,
    exitOnCtrlC: false, // Ctrl-C cancels the agent turn, it does not quit
    maxFps: 60,
  });
}
