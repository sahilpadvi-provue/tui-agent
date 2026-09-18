/**
 * The surface every screen is written against.
 *
 * `Stack`, `Label`, `Settled` and four hooks, and nothing here knows how a
 * frame reaches the terminal -- that is a `Backend`, chosen at `mount` and
 * read from context by everything below it. Swapping renderers is writing one
 * more file in `backends/`; this file and `App.tsx` do not move.
 *
 * Context rather than a module-level global on purpose. A global would have to
 * be set before the first import to be reliable, which makes the choice a
 * property of module load order, and it would put two backends in the shipped
 * binary to allow a switch nothing at runtime asks for.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type {
  Backend, Color, Instance, Key, MountOptions as BackendMountOptions, SettledProps,
} from "./backend.ts";
import { cellsBackend } from "./backends/cells.tsx";
import type { Paint } from "../theme/index.ts";

export type { Color, Instance, Key };

const BackendContext = createContext<Backend>(cellsBackend);

/**
 * The hooks below call a hook taken from context, which is only sound because
 * the backend cannot change for the life of a mount: `mount` fixes it and the
 * provider value is never replaced. Nothing here may become conditional.
 */
function useBackend(): Backend {
  return useContext(BackendContext);
}

export type StackProps = {
  children?: ReactNode;
  direction?: "row" | "column";
  padX?: number;
  /** A rule above and below. `borderSides` is accepted and ignored: the only
   *  value the UI asks for is "y", which is what a rule already is. */
  border?: boolean;
  borderSides?: "all" | "y";
  borderColor?: Paint;
  borderDim?: boolean;
  /** "between" pushes the last child to the right edge. */
  align?: "start" | "end" | "between";
};

export function Stack({ borderSides: _ignored, children, ...rest }: StackProps) {
  const { Box } = useBackend();
  return <Box {...rest}>{children}</Box>;
}

export type LabelProps = {
  children?: ReactNode;
  color?: Paint;
  bg?: Paint;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
};

export function Label({ children, ...rest }: LabelProps) {
  const { Text } = useBackend();
  return <Text {...rest}>{children}</Text>;
}

export function Settled<T>(props: SettledProps<T>) {
  const Impl = useBackend().Settled;
  return <Impl {...props} />;
}

export function useKeys(fn: (char: string, key: Key) => void): void {
  useBackend().useKeys(fn);
}

export function usePaste(fn: (text: string) => void): void {
  useBackend().usePaste(fn);
}

/**
 * The width, not the stream.
 *
 * This used to hand out `process.stdout` and let callers read `.columns` off
 * it, which was the one part of this surface that named a mechanism rather
 * than a need -- and the only member a renderer without a Node stream behind
 * it could not have satisfied.
 */
export function useColumns(): number {
  return useBackend().useColumns();
}

export function useApp(): { exit: () => void } {
  return { exit: useBackend().useExit() };
}

export type MountOptions = BackendMountOptions & {
  /** Defaults to the cell renderer. `scripts/backend-check.tsx` passes Ink. */
  backend?: Backend;
};

export function mount(node: ReactNode, options: MountOptions = {}): Instance {
  const backend = options.backend ?? cellsBackend;
  const wrap = (n: ReactNode) => (
    <BackendContext.Provider value={backend}>{n}</BackendContext.Provider>
  );
  const instance = backend.mount(wrap(node), options);
  // A rerender has to re-apply the provider. Handing the backend a bare node
  // changes the root element's type, and React answers that by unmounting the
  // tree and building a new one -- every piece of UI state, including a queued
  // instruction, silently resets. `scripts/queue-check.tsx` is what caught it.
  return {
    rerender: (next) => instance.rerender(wrap(next)),
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

/** One frame as plain rows. How a backend is compared to another, and to itself. */
export function renderToText(
  node: ReactNode,
  columns: number,
  backend: Backend = cellsBackend,
): string[] {
  return backend.renderToText(
    <BackendContext.Provider value={backend}>{node}</BackendContext.Provider>,
    columns,
  );
}
