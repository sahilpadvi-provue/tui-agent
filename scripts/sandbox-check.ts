/** Verifies the OS sandbox actually contains writes and egress. */
import { LocalExecutor } from "../src/exec/local.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ws = mkdtempSync(join(tmpdir(), "sbcheck-"));
mkdirSync(join(ws, ".git/hooks"), { recursive: true });
const ex = new LocalExecutor(ws, { sandbox: true, allowNetwork: false });
console.log(`sandbox: ${ex.describeSandbox()}`);
let failures = 0;

async function expect(name: string, cmd: string, want: "allowed" | "blocked") {
  let out = "";
  await ex.run(cmd, { cwd: ws }, (c) => { out += c.text; });
  const blocked = /not permitted|Operation not permitted|blocked/i.test(out);
  const got = blocked ? "blocked" : "allowed";
  if (got === want) console.log(`ok   ${name} (${got})`);
  else { console.log(`FAIL ${name}: wanted ${want}, got ${got} — ${out.trim().slice(0, 80)}`); failures++; }
}

await expect("workspace write", "echo ok > inside.txt && cat inside.txt", "allowed");
await expect("home write", "echo x > ~/sbcheck-escape.txt", "blocked");
await expect("git hook write", "echo x > .git/hooks/pre-commit", "blocked");
await expect("network egress", "curl -s --max-time 3 https://example.com > /dev/null && echo reached || echo blocked", "blocked");
await expect("read outside (documented limit)", "head -1 /etc/hosts", "allowed");

process.exit(failures ? 1 : 0);
