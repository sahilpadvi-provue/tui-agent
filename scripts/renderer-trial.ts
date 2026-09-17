/** Both arms, one process each, same App and the same four narrowings. */
const run = async (cells: boolean) => {
  const args = cells
    ? ["--preload", "./scripts/cells-preload.ts", "scripts/renderer-trial.tsx"]
    : ["scripts/renderer-trial.tsx", "--ink"];
  const p = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const line = out.split("\n").filter((l) => l.startsWith("{")).pop();
  return line ? JSON.parse(line) : { error: (await new Response(p.stderr).text()).slice(-300) };
};

const ink = await run(false);
const cells = await run(true);

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

console.log("     ink:  ", JSON.stringify(ink));
console.log("     cells:", JSON.stringify(cells));
console.log();

// Asserted only of the cell renderer. Ink's number is printed for context and
// not checked: driving Ink through a synthetic terminal here does not
// reproduce its on-screen behaviour faithfully -- it reported more rules
// before the narrowing than after, which is not a thing that can happen. Ink's
// ghosting is already established by `scripts/reflow-check.tsx` and by
// watching it, and does not need a second-rate control arm.
check("the chrome is actually drawn", cells.rulesBefore === 2, `${cells.rulesBefore} rules`);
check("the footer is split to the right edge", cells.splitFooter === true);
check("four narrowings leave exactly those two rules", cells.rulesAfter === 2, `${cells.rulesAfter} rules`);
check("the composer survives", cells.composer === true);
check("typing still reaches the app", cells.typed === true);
check("a bracketed paste still becomes a chip", cells.chip === true);

console.log(failures === 0 ? "\nthe chrome is drawn and it still does not ghost" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

export {};
