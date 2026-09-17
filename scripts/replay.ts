/**
 * Stage 0 gate: reconstruct a conversation from a log file alone.
 *
 * If this is awkward to write, the log design is wrong and now is the
 * cheap moment to change it.
 */
import { EventLog } from "../src/core/log.ts";
import { project } from "../src/core/projection.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run scripts/replay.ts <log.jsonl>");
  process.exit(1);
}

const { meta, events } = EventLog.readFile(path);
const { messages, dropped } = project(events);

console.log(`session ${meta.sessionId}  protocol v${meta.protocolVersion}`);
console.log(`model ${meta.model}  cwd ${meta.cwd}`);
console.log(`${events.length} events -> ${messages.length} visible messages\n`);

for (const m of messages) {
  const tag = m.toolName ? `${m.role}:${m.toolName}` : m.role;
  const body = m.toolArgs !== undefined ? JSON.stringify(m.toolArgs) : m.text;
  const reasoning = m.reasoning ? "  [+reasoning]" : "";
  console.log(`  #${String(m.seq).padStart(3)} ${tag.padEnd(16)} ${truncate(body)}${reasoning}`);
}

if (dropped.length) {
  console.log(`\ncompacted:`);
  for (const d of dropped) {
    const stillHidden = d.seqs.filter((s) => !messages.some((m) => m.seq === s));
    console.log(`  ${d.seqs.length} events dropped (${d.reason})`);
    console.log(`    summary: ${d.summary}`);
    console.log(`    seqs: ${d.seqs.join(", ")}  [${stillHidden.length} still hidden]`);
  }
}

function truncate(s: string, n = 80): string {
  const flat = s.replace(/\n/g, "\\n");
  return flat.length > n ? flat.slice(0, n) + "..." : flat;
}
