/**
 * Ink as a backend.
 *
 * Kept because a contract with one implementation behind it is a guess. This
 * is the second one, and `scripts/backend-check.tsx` holds both to the same
 * answer on every run -- which is a cheaper way to know the boundary is real
 * than discovering it at the next swap.
 *
 * It is also the control arm: Ink still reflows a frame as one string and
 * repositions by counting its newlines, which is ink#907, so the difference
 * this backend shows is the reason the default is `cells`.
 *
 * Ink is a dev dependency and nothing in `src/` imports this file, so the
 * shipped binary does not carry either.
 */

import React, { type ReactNode } from "react";
import {
  render, renderToString, Box as InkBox, Text as InkText, Static,
  useApp, useInput, usePaste as useInkPaste, useWindowSize,
} from "ink";
import type {
  Backend, BoxProps, Instance, Key, MountOptions, SettledProps, TextProps,
} from "../backend.ts";

/**
 * `border` means a rule above and below, which Ink draws as a box with two
 * sides switched off. A full `borderStyle` would add the verticals the cell
 * renderer never draws, and the gate compares visible text.
 */
function Box({
  children, direction = "column", padX, border, borderColor, borderDim, align,
}: BoxProps) {
  return (
    <InkBox
      flexDirection={direction}
      paddingX={padX}
      borderStyle={border ? "single" : undefined}
      borderLeft={border ? false : undefined}
      borderRight={border ? false : undefined}
      borderColor={border ? borderColor : undefined}
      borderDimColor={border ? borderDim : undefined}
      justifyContent={
        align === "between" ? "space-between" : align === "end" ? "flex-end" : undefined
      }
    >
      {children}
    </InkBox>
  );
}

function Text({ children, color, bg, dim, bold, italic }: TextProps) {
  return (
    <InkText color={color} backgroundColor={bg} dimColor={dim} bold={bold} italic={italic}>
      {children}
    </InkText>
  );
}

/** `Static` prints once and will not reprint, so `render` must key its root. */
function Settled<T>({ items, render: renderItem }: SettledProps<T>) {
  return <Static items={items}>{(item, i) => renderItem(item, i)}</Static>;
}

/** Ink's `Key` carries every field ours does and six more, so it passes through. */
function useKeys(fn: (char: string, key: Key) => void): void {
  useInput((input, key) => fn(input, key));
}

function useColumns(): number {
  return useWindowSize().columns;
}

function useExit(): () => void {
  return useApp().exit;
}

function mount(node: ReactNode, options: MountOptions = {}): Instance {
  const instance = render(node, {
    stdout: options.stdout ?? process.stdout,
    stdin: options.stdin ?? process.stdin,
    // Ctrl-C cancels a turn and quits on the second press; letting Ink own it
    // would take the only way out of a running turn away.
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 60,
    onRender: options.onRender ? () => options.onRender?.() : undefined,
  });
  return {
    rerender: (next) => instance.rerender(next),
    unmount: () => instance.unmount(),
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
  };
}

/**
 * Broader than an SGR strip: `renderToString` also emits cursor and erase
 * sequences, and leaving one in makes a row differ from the same row drawn by
 * a renderer that never wrote it.
 */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function renderToText(node: ReactNode, columns: number): string[] {
  return renderToString(node, { columns })
    .replace(CSI, "")
    .split("\n")
    .map((row) => row.replace(/\s+$/, ""));
}

export const inkBackend: Backend = {
  name: "ink",
  Box,
  Text,
  Settled,
  mount,
  useKeys,
  usePaste: useInkPaste,
  useColumns,
  useExit,
  renderToText,
};
