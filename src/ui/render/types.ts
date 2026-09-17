/**
 * The colour names, apart from the module that re-exports them.
 *
 * `screen.ts` needs `Color` and `primitives.tsx` needs `screen.ts`, so keeping
 * the type where the public surface is would make the two import each other.
 * It is erased at runtime and the cycle would be harmless, but a cycle that
 * has to be explained is worse than a four-line file.
 */
export type Color =
  | "black" | "red" | "green" | "yellow" | "blue"
  | "magenta" | "cyan" | "white" | "gray" | "grey";
