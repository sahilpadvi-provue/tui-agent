/**
 * `react-reconciler` ships no types, and `@types/react-reconciler` lags the
 * runtime -- Ink carries a `@ts-expect-error` for that reason. Declaring only
 * the three calls used here is more honest than a stale package.
 */
declare module "react-reconciler" {
  export type Container = { readonly __container: unique symbol };
  export type Reconciler = {
    createContainer(
      root: unknown, tag: number, hydrate: null, strict: boolean,
      concurrent: null, prefix: string,
      onUncaught: (e: unknown) => void, onCaught: (e: unknown) => void,
      onRecoverable: (e: unknown) => void, transition: null,
    ): Container;
    updateContainerSync(element: unknown, container: Container, parent: null, callback: null): void;
    flushSyncWork(): void;
  };
  export default function createReconciler(config: object): Reconciler;
}

declare module "react-reconciler/constants.js" {
  export const DefaultEventPriority: number;
  export const NoEventPriority: number;
  export const LegacyRoot: number;
}
