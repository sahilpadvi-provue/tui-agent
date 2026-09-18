/**
 * One source of time, for everything that moves.
 *
 * Every animated component samples the same clock, so all motion in a frame
 * lands in one commit rather than each piece producing its own. A requested
 * interval is rounded up to a multiple of `TICK_MS`, which is what makes that
 * true: two pieces asking for 90ms and 1000ms stay in step instead of drifting
 * into separate repaints.
 *
 * The timer is created by the first subscriber and cleared by the last, so a
 * screen with nothing animating has no timer at all. That is not a
 * micro-optimisation, it is what keeps a defect visible: a running timer
 * re-renders on its next tick and picks up whatever went wrong, so anything
 * with motion on screen looks correct whether or not a resize did any work.
 * `scripts/quiet-resize-check.tsx` exists because that bug shipped once, and
 * it can only see it on a screen that is genuinely still.
 *
 * Not a renderer frame loop, and deliberately not part of the `Backend`
 * contract. This produces state changes; React commits them; whichever backend
 * is mounted paints the result. It needs no knowledge of how a frame reaches
 * the terminal and therefore needs no second implementation for Ink.
 */

import { useCallback, useSyncExternalStore } from "react";

/**
 * The quantum. 80ms, not 16.
 *
 * Perceived motion in a terminal runs an order of magnitude below display
 * refresh everywhere it has been measured: 63 of the 92 `cli-spinners`
 * defaults are 80ms, ratatui recommends 250ms, and this app's own shimmer was
 * 90ms by eye. 60Hz is a ceiling on flush, never the rate of motion -- and
 * here a tick costs a repaint, which is O(the whole transcript).
 */
export const TICK_MS = 80;

type Watcher = { readonly step: number; readonly notify: () => void };

const watchers = new Set<Watcher>();
let timer: ReturnType<typeof setInterval> | undefined;
let ticks = 0;

function advance(): void {
  ticks += 1;
  // An optimisation, not a correctness property, and worth saying which.
  // Every phase is derived from `ticks`, so a watcher woken on a tick that
  // cannot change its phase reads the same snapshot and `useSyncExternalStore`
  // bails out without rendering. Removing this modulo changes no assertion in
  // `clock-check` -- measured. It is here to skip waking React at all for a
  // watcher slower than the quantum, which for a 500ms blink is six wakeups
  // saved per blink.
  for (const w of [...watchers]) if (ticks % w.step === 0) w.notify();
}

function watch(step: number, notify: () => void): () => void {
  const w: Watcher = { step, notify };
  watchers.add(w);
  if (!timer) {
    // Only on creation. Resetting when a second watcher joins would jump the
    // phase of the one already running.
    ticks = 0;
    timer = setInterval(advance, TICK_MS);
  }
  return () => {
    watchers.delete(w);
    if (watchers.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const idle = () => {};

/**
 * A counter that advances every `everyMs`, shared with everything else moving.
 *
 * `null` subscribes to nothing and returns a constant, so switching motion off
 * is a decision about whether to subscribe rather than a branch at render
 * time -- which means it cannot leave anything half-animated.
 */
export function usePhase(everyMs: number | null): number {
  const step = everyMs === null ? null : Math.max(1, Math.ceil(everyMs / TICK_MS));
  const subscribe = useCallback(
    (notify: () => void) => (step === null ? idle : watch(step, notify)),
    [step],
  );
  const read = useCallback(() => (step === null ? 0 : Math.floor(ticks / step)), [step]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Motion the user has asked not to see.
 *
 * `NO_COLOR`'s rule, because it is one line and people already know it:
 * present in the environment and non-empty suppresses, whatever the value.
 *
 * Deliberately not tied to `isTTY`. That switch is for pipes and CI and says
 * nothing about a human on a real terminal with a screen reader, and
 * conflating the two is the usual bug.
 *
 * Decoration only. The elapsed clock goes nowhere near this: a number that
 * stops counting is not calmer, it is broken, and a local model can think for
 * minutes.
 */
const SUPPRESSED = (process.env["NO_MOTION"] ?? "") !== "";

/** An interval for decorative motion, or `null` when it is suppressed. */
export function motion(everyMs: number): number | null {
  return SUPPRESSED ? null : everyMs;
}

/** Only for gates: whether a timer is running at all. */
export function clockRunning(): boolean {
  return timer !== undefined;
}
