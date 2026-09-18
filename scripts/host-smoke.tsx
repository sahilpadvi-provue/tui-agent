/**
 * The host config produces the rows the components describe, and a rerender
 * touches only the row that changed.
 */
import React, { useEffect, useState } from "react";
import { Stack, Label, Settled, mount } from "../src/ui/primitives.tsx";
import { slot } from "../src/theme/index.ts";

let buf = "";
const out: any = Object.assign(
  new (await import("node:stream")).Writable({ write(c: any, _e: any, cb: any) { buf += String(c); cb(); return true; } }),
  { columns: 60, rows: 12, isTTY: true },
);

function Demo({ tick }: { tick: number }) {
  return (
    <>
      <Settled items={["one", "two"]} render={(t, i) => <Label key={i} dim>{`  ${t}`}</Label>} />
      <Stack direction="column">
        <Stack direction="row" padX={2}>
          <Label color={slot("cyan")}>{"· "}</Label>
          <Label bold>working</Label>
          <Label dim>{`  ${tick}s`}</Label>
        </Stack>
      </Stack>
    </>
  );
}

const app = mount(<Demo tick={0} />, { stdout: out });
await new Promise((r) => setTimeout(r, 30));
app.rerender(<Demo tick={7} />);
await new Promise((r) => setTimeout(r, 30));
app.unmount();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` \u2014 ${detail}`}`);
  if (!ok) failures++;
};

const rows = buf
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  .split("\r")
  .map((s) => s.replace(/\n/g, ""))
  .filter((s) => s.trim());

check("components become rows", rows.slice(0, 3).join("|") === "  one|  two|  \u00b7 working  0s",
  rows.slice(0, 3).join("|"));
check("padX is applied once, not twice", rows[2]?.startsWith("  \u00b7") === true, rows[2]);
check("a rerender rewrites only what changed", rows.length === 4, `wrote ${rows.length} rows`);
check("the changed row carries the new value", rows[3] === "  \u00b7 working  7s", rows[3]);

process.exit(failures === 0 ? 0 : 1);
