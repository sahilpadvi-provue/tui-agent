/** Session inspection: list, show what compaction hid, and restore it. */
import { listSessions, resume, sessionLine } from "../core/session.ts";
import { project } from "../core/projection.ts";
import { listCheckpoints } from "../exec/checkpoint.ts";

const [cmd, arg, arg2] = process.argv.slice(2);

switch (cmd) {
  case "list": {
    const sessions = listSessions();
    if (!sessions.length) { console.log("no sessions"); break; }
    for (const s of sessions) console.log(sessionLine(s));
    break;
  }

  case "context": {
    if (!arg) { console.error("usage: sessions context <id>"); process.exit(1); }
    const { history } = resume(arg);
    const { messages, dropped } = project(history);
    console.log(`${messages.length} messages in context, ${dropped.length} compaction(s)`);
    for (const d of dropped) {
      const hidden = d.seqs.filter((s) => !messages.some((m) => m.seq === s));
      console.log(`\n  hid ${d.seqs.length} events (${hidden.length} still hidden)`);
      console.log(`  reason:  ${d.reason}`);
      console.log(`  summary: ${d.summary}`);
      console.log(`  restore: bun run sessions restore ${arg} ${d.seqs.join(",")}`);
    }
    break;
  }

  case "restore": {
    if (!arg || !arg2) { console.error("usage: sessions restore <id> <seq,seq,...>"); process.exit(1); }
    const seqs = arg2.split(",").map(Number).filter(Number.isFinite);
    const { bus, log } = resume(arg);
    bus.on((e) => log.append(e));
    bus.emit({ sessionId: arg, type: "context.restored", restoredSeqs: seqs });
    console.log(`restored ${seqs.length} events into ${arg}'s context`);
    break;
  }

  case "checkpoints": {
    const cps = listCheckpoints(process.cwd());
    if (!cps.length) { console.log("no checkpoints (not a git repo, or none taken)"); break; }
    for (const c of cps) console.log(`${c.commit.slice(0, 8)}  ${c.at.slice(0, 19)}  ${c.label}`);
    console.log(`\nrecover a file:  git show <commit>:<path>`);
    console.log(`restore all:     git restore --source=<commit> -- .`);
    break;
  }

  default:
    console.log("usage: sessions <list | context <id> | restore <id> <seqs> | checkpoints>");
}
