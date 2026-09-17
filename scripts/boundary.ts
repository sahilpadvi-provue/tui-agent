/** Verifies the workspace boundary holds against traversal and absolute paths. */
import { LocalExecutor } from "../src/exec/local.ts";
import { WorkspaceViolation } from "../src/exec/executor.ts";

const ex = new LocalExecutor(process.cwd());
const opts = { cwd: process.cwd() };
let failures = 0;

async function blocked(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`FAIL ${name}: was NOT blocked`);
    failures++;
  } catch (e) {
    if (e instanceof WorkspaceViolation) console.log(`ok   ${name}`);
    else { console.log(`FAIL ${name}: wrong error ${(e as Error).name}`); failures++; }
  }
}

async function allowed(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}: ${(e as Error).message}`); failures++; }
}

await blocked("traversal read", () => ex.readFile("../../../etc/passwd", opts));
await blocked("absolute read", () => ex.readFile("/etc/passwd", opts));
await blocked("absolute write", () => ex.writeFile("/tmp/escape.txt", "x", opts));
await blocked("traversal write", () => ex.writeFile("../escape.txt", "x", opts));
await blocked("nested traversal", () => ex.writeFile("src/../../escape.txt", "x", opts));
await allowed("in-workspace read", () => ex.readFile("package.json", opts));
await allowed("in-workspace write", () => ex.writeFile(".sessions/.probe", "x", opts));

process.exit(failures ? 1 : 0);
