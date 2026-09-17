/**
 * A resize must repaint on its own, with nothing else going on.
 *
 * This has to be asserted against a component that has no other reason to
 * render. Anything with a timer looks correct whether or not the resize does
 * any work, because the next tick re-renders and picks the new width up --
 * which is exactly how this shipped broken once. `App` has a shimmer and an
 * elapsed clock, so measuring through it cannot tell the two apart, and
 * `scripts/resize-check.tsx` passes either way.
 *
 * The failure it guards is narrow and quiet: on an idle screen, narrowing the
 * terminal does nothing at all until the next keystroke.
 */
import React, { useState } from "react";
import { PassThrough, Writable } from "node:stream";
import { mount, useKeys, useStdout, Label, Stack } from "../src/ui/render/primitives.tsx";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

function Quiet() {
  const { stdout } = useStdout();
  const [n, setN] = useState(0);
  useKeys(() => setN((v) => v + 1));
  return <Stack><Label>{`width ${stdout.columns} n ${n}`}</Label></Stack>;
}

let out = "";
const stdout: any = Object.assign(
  new Writable({ write(c, _e, cb) { out += String(c); cb(); return true; } }),
  { columns: 100, rows: 12, isTTY: true },
);
const stdin: any = Object.assign(new PassThrough(), {
  isTTY: true, setRawMode() {}, ref() {}, unref() {},
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = () => out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();

const app = mount(<Quiet />, { stdout, stdin });
await wait(150);
check("the first frame is drawn at the starting width", plain().includes("width 100"), plain());

out = "";
stdout.columns = 68;
stdout.emit("resize");
await wait(300);
check("a resize repaints with nothing else running", out.length > 0, `${out.length} bytes`);
check("and it repaints at the new width", plain().includes("width 68"), plain());

// A narrowing must not need a keystroke to be believed.
const afterResize = plain();
out = "";
stdin.write("k");
await wait(200);
check("the keystroke was not what applied the width",
  afterResize.includes("width 68"), `after resize: ${afterResize}`);
check("and the app is still live afterwards", plain().includes("n 1"), plain());

app.unmount();
console.log(failures === 0 ? "\na resize stands on its own" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
