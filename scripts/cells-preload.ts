/**
 * Points `src/ui/primitives.tsx` at the cell renderer, for one process.
 *
 * A resolver rather than an edit: `App` and `markdown` keep importing the one
 * module they are supposed to know about, `primitives.tsx` stays exactly as it
 * is on main, and the comparison costs no source change to revert.
 *
 *   bun --preload ./scripts/cells-preload.ts run src/cli/tui.tsx
 */
import { plugin } from "bun";

const CELLS = new URL("../src/ui/render/primitives.tsx", import.meta.url).pathname;

plugin({
  name: "cells-renderer",
  setup(build) {
    build.onResolve({ filter: /primitives\.tsx$/ }, (args) =>
      // The renderer's own modules must keep resolving normally, or this
      // redirects the replacement to itself.
      args.importer.includes("/src/ui/render/") ? undefined : { path: CELLS },
    );
  },
});
