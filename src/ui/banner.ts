import type { Line } from "./layout.ts";

/**
 * What is running, before anything has happened.
 *
 * Three facts a person needs on launch and nowhere else: which build, which
 * model, and where it is pointed. It is emitted as ordinary transcript lines
 * so it prints once and scrolls away with the rest of the history -- a banner
 * pinned above the prompt would cost those rows for the whole session.
 */
export function bannerLines(o: {
  version: string;
  model: string;
  backend: string;
  sandbox: string;
  cwd: string;
}): Line[] {
  return [
    { text: `● tui-agent ${o.version}`, color: "cyan" },
    { text: `  ${o.model} · ${o.backend} · ${o.sandbox}`, dim: true },
    { text: `  ${o.cwd}`, dim: true },
    { text: "" },
  ];
}
