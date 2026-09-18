import { styled, type Line } from "./layout.ts";

/**
 * What is running, before anything has happened.
 *
 * Three facts a person needs on launch and nowhere else: which build, which
 * model, and where it is pointed. It is emitted as ordinary transcript lines
 * so it prints once and scrolls away with the rest of the history -- a banner
 * pinned above the prompt would cost those rows for the whole session.
 *
 * Labels are aligned and dimmed so the values form a column the eye can read
 * down without reading the labels at all.
 */
export function bannerLines(o: {
  version: string;
  model: string;
  backend: string;
  sandbox: string;
  cwd: string;
}): Line[] {
  const label = (text: string) => ({ text: text.padEnd(10), dim: true });

  return [
    styled(
      0,
      { text: "● ", color: "green" },
      { text: "tui-agent", bold: true },
      { text: `  ${o.version}`, dim: true },
    ),
    styled(0, label("  model"), { text: o.model }, { text: `  ${o.backend}`, dim: true }),
    styled(0, label("  sandbox"), { text: o.sandbox, dim: true }),
    styled(0, label("  cwd"), { text: o.cwd, dim: true }),
    { text: "" },
  ];
}
