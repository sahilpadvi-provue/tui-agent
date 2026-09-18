/** The wall-bench scene as plain rows, so the OpenTUI arm can be held to the same screen. */
import React from "react";
import { Stack, Label, renderToText } from "../src/ui/primitives.tsx";
import { cellsBackend } from "../src/ui/backends/cells.tsx";
import { inkBackend } from "../src/ui/backends/ink.tsx";
import { slot } from "../src/theme/index.ts";

const cyan = slot("cyan");

const WIDTH = 100, BODY = 34, FOOTER = 6;
const backend = process.env.BACKEND === "ink" ? inkBackend : cellsBackend;
const body = Array.from({ length: BODY }, (_, i) =>
  `line ${i}: ${"lorem ipsum ".repeat(5)}`.slice(0, WIDTH - 1));
const footer = Array.from({ length: FOOTER }, (_, i) => `footer ${i}`);

const rows = renderToText(
  <Stack direction="column">
    {body.map((line, i) => (
      <Label key={i} color={i % 3 === 0 ? cyan : undefined} bold={i % 7 === 0}>{line}</Label>
    ))}
    <Stack direction="column">
      {footer.map((line, i) => <Label key={i} dim={i > 0}>{line}</Label>)}
    </Stack>
  </Stack>,
  WIDTH, backend,
);
console.log(JSON.stringify(rows.map((r) => r.replace(/\s+$/, ""))));
