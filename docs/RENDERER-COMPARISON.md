# Cell renderer vs Ink vs OpenTUI

Measured 2026-09-18 against `omkardate-p/infinity@650d838` (`@opentui/core`
0.5.11), this repo at `9833f1c` plus the frame cap below. macOS arm64, Bun 1.4.2.

Re-measured at those heads after infinity moved four commits, two of them in
its render path (`15c1022` on control characters and grapheme-safe cursors,
`650d838` adding a command menu under the composer). Neither moved its figures:
22677 bytes on the app burst against 22631 before, 128058 paced against 128112.
The menu costs nothing at rest because it does not render until invoked.

Harnesses: `scripts/wall-bench.tsx` and `scripts/app-bench.tsx` here,
`bench/wall-bench.tsx` and `bench/app-bench.tsx` on infinity's `perf-bench`
branch. Every figure is the median of five runs (three for app/paced), each a
fresh process.

## What was held equal

The renderer comparison draws one 100x40 screen -- 34 body rows, a 6-row
footer, a cyan every third row, bold every seventh. `scripts/wall-scene.tsx`
and its counterpart dump that screen as plain rows from all three renderers:
**40 rows, byte-identical**. Nothing below is a comparison of different
pictures.

Two things had to be corrected before the numbers meant anything, and both are
worth knowing independently of this exercise.

**Ink writes no colour unless `FORCE_COLOR` is set.** chalk reads the real
`process.stdout`, not the stream Ink was handed, so under a piped harness every
code is stripped and Ink appears to write less because it is writing less.
`src/ui/README.md` already records this trap; it cost a measurement here
anyway. The Ink arm runs with `FORCE_COLOR=3`.

**OpenTUI pays a fixed terminal handshake.** Rendering an empty box and waiting
400ms: cells writes 20 bytes, Ink 0, OpenTUI **5542**. It is DA1, six DECRQM
queries, an OSC 10/11 colour query, a kitty graphics probe and an iTerm2
capability request. So OpenTUI's 6269-byte "first paint" is ~5.5KB of
negotiation and ~0.7KB of screen, against cells' 20 bytes of setup and ~2.9KB
of screen. One-time, and it buys capability detection the cell renderer infers
from `COLORTERM`.

## The frame cap

Measuring this uncapped found the one defect worth fixing on our side: the cell
renderer scheduled a draw on a microtask with no rate limit, so it repainted at
every yield of the loop. A 2000-token stream painted **41 times where a
terminal could show 5**, and the writes for the other 36 went nowhere a human
could read.

`FRAME_MS = 16` in `src/ui/backends/cells.tsx`, leading edge: paint at once if
the budget is spent, otherwise defer to the remainder of it. Trailing edge
would have been simpler and wrong -- it puts 16ms between a keystroke and the
character, which is the one latency in this renderer anybody feels. The
deferred timer exists only while a paint is owed, so an idle screen still has
no clock running and `clock:check` stays meaningful.

`scripts/latency-check.tsx` gates both halves, because passing one is what a
wrong implementation looks like. It fails on the pre-cap renderer (24 frames
against a ceiling of 12) and passes after.

Its keystroke budget is `FRAME_MS / 2`, derived rather than chosen. A fixed 5ms
failed 1 run in 10 at a measured p50 of 0.83ms, which is the gate reporting the
machine rather than the code; deriving it from the constant under test also
keeps it meaningful if `FRAME_MS` ever moves. 15 consecutive runs green after,
and the negative control still fails.

**A resize goes through the cap too**, since width reaches the screen as a
React re-render. Measured, resize event to bytes on the wire: **idle screen p50
1.5ms, max 4.5ms; mid-stream p50 15.4ms, max 15.9ms.** Leading edge is why the
idle case is unaffected -- the budget is long spent, so the repaint is
immediate. Only a resize landing within 16ms of a paint waits, and never for
longer than the remainder. `render:check` and `quiet-resize-check` both exercise
the idle case, so their margin is unchanged rather than newly narrow.

What the cap bought, same workloads, cells only, both sides measured at
`287675b` so the pair isolates the cap rather than the two commits since.
Frames and bytes are the load-bearing columns; RSS is shown for completeness
and is a single observation apiece:

| | frames | bytes | B/frame | rss MB |
| --- | ---: | ---: | ---: | ---: |
| renderer burst, before | 41 | 26766 | 653 | 80.4 |
| renderer burst, after | **5** | **1615** | **323** | 75.4 |
| app burst, before | 45 | 43061 | 957 | 146.0 |
| app burst, after | **10** | **15923** | **1592** | 132.4 |

94% fewer bytes on the renderer burst, 63% on the app. Frames now match
OpenTUI's exactly, and bytes beat it.

The cap also hides the renderer's raw speed: paced latency is now the budget by
construction, not the cost. The compute figure below was taken by removing the
cap, the same way the gate's negative control does.

## Renderer, burst

2000 updates pushed as fast as the loop allows, letting each renderer coalesce.
This is what streaming a model's tokens actually looks like.

| arm | cold ms | ticks/s | frames | bytes | B/frame | heap MB | rss MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cells | 64 | 5628 | 5 | **1599** | 320 | 38.8 | 76.2 |
| ink | 71 | 5533 | 5 | 4271 | 854 | 39.5 | 105.3 |
| opentui | 74 | 5660 | 5 | 12653 | 2531 | **8.0** | 77.3 |

All three now coalesce 2000 updates to 5 frames. The cell renderer writes
**2.8x fewer bytes than Ink and 7.8x fewer than OpenTUI** for the same screen,
because OpenTUI emits 24-bit colour where a slot here becomes basic SGR.

## Renderer, paced

500 updates, each one waited to the wire before the next is sent, so every tick
is one painted frame. The wait is on bytes reaching stdout, the one signal all
three share.

| arm | ticks/s | p50 ms | p95 ms | p99 ms | bytes | B/frame | heap MB | rss MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cells | 59 | 16.460 | 17.040 | 18.685 | 94290 | 189 | 42.1 | 103.5 |
| ink | 81 | 19.256 | 22.132 | 23.167 | 1086773 | 2169 | 41.9 | 191.4 |
| opentui | 56 | 17.287 | 17.999 | 19.337 | **78560** | **157** | **10.3** | 109.5 |

**Every p50 here is a frame cap, not a cost.** Ours is 16ms by construction.
OpenTUI's moves in lockstep with `targetFps`: 60 -> 17.2ms, 120 -> 8.6ms, 240
-> 3.8ms, 480 -> 1.40ms, 1000 -> 1.41ms, so its floor is **1.40ms and ~410
painted frames a second**. Ink's 19ms is also a cap and is not configurable
from its public API.

Uncapped compute per painted frame: **cells 0.175ms, OpenTUI 1.40ms, Ink
19.3ms.** Our renderer is genuinely ~8x cheaper per frame than OpenTUI. That
headroom is now spent on not painting rather than on painting faster, which is
the right trade -- no terminal was going to show frame 41.

Bytes per frame still run the other way: OpenTUI's native diff writes 157 where
we write 189 and Ink writes 2169. Ink rewrites most of the screen every frame,
and a remote or slow terminal pays for that directly.

## Whole app

Each repo's real `App` under one streamed answer. Not the same screen, on
purpose: infinity runs split-footer, committing settled rows to the terminal's
own scrollback and redrawing only an 8-row footer, while this repo redraws a
viewport. The gap between the two is the gap between the designs. Deltas are
fed through a stub `Model` on infinity's side and the event bus on ours.

Burst, 2000 deltas:

| arm | ticks/s | frames | bytes | heap MB | rss MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| cells | 5358 | 10 | **15899** | 40.0 | 132.3 |
| ink | 4013 | 46 | 253168 | 45.7 | 201.3 |
| opentui | 5503 | 10 | 22677 | **12.3** | 107.0 |

Paced, 1000 deltas:

| arm | ticks/s | p50 ms | bytes | B/frame | heap MB | rss MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cells | 60 | 16.535 | 139084 | 138 | 55.7 | 131.2 |
| ink | 496 | 1.591 | 3202455 | 3187 | 45.4 | 227.7 |
| opentui | 57 | 17.094 | 128058 | **127** | **16.0** | **101.1** |

Capping cost bytes in app/paced -- 113114 before, ~139000 after -- and that is
an artifact of the mode rather than of the cap. Pacing 1000 deltas at 16ms each
takes 16.6s of wall clock against 0.9s uncapped, and the decorative animation
advances the whole time. The same run with `NO_MOTION=1` writes **110275**,
below the uncapped figure. Burst, where wall clock is not stretched, shows the
63% reduction instead.

Split-footer earns its keep on memory rather than on frames now that both
coalesce to 10. OpenTUI keeps its screen in native memory, so **its JS heap
stays at 12-16MB against our 40-57MB**. That is the memory claim worth making:
the heap figures are stable run to run, the RSS ones are not (see below), so the
RSS columns are reported as observations rather than as a ranking. Bun's floor
is 11.4MB RSS for scale.

## The RSS growth, unresolved

**One thing survives: the JS heap is flat.** 38.5 to 39.0MB across a 400x range
in frames with `Bun.gc(true)` forced before each reading, and 38.5 to 43.4MB
across a 32x range measured independently with no forced GC at all. Two routes,
same answer. Nothing is leaking on the JS side.

**The RSS shape does not survive.** An earlier version of this document read a
climb and a plateau at roughly 110MB off one run per frame count. Repeating the
same command at the same head shows that was noise:

| condition | frames | runs |
| --- | ---: | --- |
| GC forced | 2000 | 117.9, 62.9, 85.5, 82.0, 82.8 |
| no forced GC | 2000 | 95.1, 113.0, 118.2, 77.6, 118.9 |
| no forced GC | 4000 | 44.8, 61.5, 70.2, 80.6 |

55MB of spread on identical input with GC forced, 41MB without, and 4000 frames
measuring *lower* than 2000 in three runs of four. Forcing the collection does
not tighten it. No claim about a climb, a ceiling or a plateau can rest on that,
and the earlier one did.

**RSS from this harness is too noisy to shape.** Settling it would need medians
of five per point at minimum, and probably a different instrument: RSS counts
shared pages and pages the allocator has not returned, neither of which tracks
the work done. Use the heap figures for memory claims and treat the RSS columns
in the tables above as single observations, not as a trend.

The app arm retains a transcript that genuinely grows, which is a real effect
and a separate question from this one.

## Reproducing

To exercise the gate's negative control, keep the `FRAME_MS` export and revert
only the three scheduler lines in `root.onRender`. Reverting `cells.tsx`
wholesale removes the export too, and `latency-check` then dies at import with
`SyntaxError: Export named 'FRAME_MS' not found` and exit 1 -- which any
pass/fail harness reads as the assertion failing, while the assertion never
runs. Check for the `ceiling` text in the output, not just the exit code.

```bash
# this repo
bun run scripts/latency-check.tsx                      # the cap's two halves
MODE=burst TICKS=2000 BACKEND=cells bun run scripts/wall-bench.tsx
MODE=paced TICKS=500  BACKEND=ink FORCE_COLOR=3 bun run scripts/wall-bench.tsx
BACKEND=cells bun run scripts/wall-scene.tsx           # the screen, as plain rows

# infinity, perf-bench branch
MODE=paced TICKS=500 FPS=240 bun run bench/wall-bench.tsx
bun run bench/wall-scene.tsx
```
