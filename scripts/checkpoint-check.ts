/** Verifies a checkpoint restores damage without touching the user's git state. */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkpoint, restore, listCheckpoints } from "../src/exec/checkpoint.ts";

const ws = mkdtempSync(join(tmpdir(), "ckpt-"));
const sh = (c: string) => execSync(c, { cwd: ws, stdio: "pipe" }).toString();
sh("git init -q && git config user.email t@t && git config user.name t");
writeFileSync(join(ws, "file.txt"), "original\n");
sh("git add -A && git commit -qm base");
writeFileSync(join(ws, "staged.txt"), "user staged this\n");
sh("git add staged.txt");

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const cp = checkpoint(ws, "before test");
check("checkpoint created", !!cp);

writeFileSync(join(ws, "file.txt"), "DESTROYED\n");
check("damage applied", readFileSync(join(ws, "file.txt"), "utf8").includes("DESTROYED"));

restore(ws, cp!.commit);
check("file restored", readFileSync(join(ws, "file.txt"), "utf8") === "original\n");
check("user's index untouched", sh("git status --short").includes("A  staged.txt"));
check("no user-visible commits added", sh("git log --oneline").trim().split("\n").length === 1);
check("checkpoint listed", listCheckpoints(ws).length === 1);

process.exit(failures ? 1 : 0);
