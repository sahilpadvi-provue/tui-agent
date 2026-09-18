import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Stack, Label, Settled, useKeys, usePaste, useColumns, useApp } from "./primitives.tsx";
import type { Color } from "./backend.ts";
import { reduce, initialState, cleared, type ViewItem } from "./model.ts";
import { Markdown } from "./markdown.tsx";
import { bannerLines } from "./banner.ts";
import {
  BLANK, DEPTH, GUTTER, STEP,
  clip, highlightCommand, measureAt, outputLines, shimmer, shortenPath, styled,
  summariseCall, verbFor, wrap,
  type Line as L,
} from "./layout.ts";
import {
  composerRows, expandPastes, normalizeNewlines, pasteId, pasteMark,
  rowDown, rowUp, wordLeft, wordRight,
} from "./editor.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { TICK_MS, motion, usePhase } from "./clock.ts";
import { radiusLines } from "../permissions/policy.ts";
import { COMMANDS, isCommand } from "../commands/registry.ts";
import type { EventBus } from "../core/bus.ts";
import type { AgentEvent, PermissionDecision } from "../core/events.ts";

/**
 * A session as the picker shows it. Display rows rather than `SessionSummary`,
 * so reading the log directory stays in `cli/` and `ui/` keeps its distance
 * from `core/`.
 */
export type SessionChoice = { id: string; label: string };

export type AppProps = {
  bus: EventBus;
  cwd: string;
  model: string;
  version: string;
  /** Where the model runs. Shown once, on launch. */
  backend: string;
  /** How the session is contained, in the words the executor reports. */
  sandbox: string;
  /** Current git branch, when the workspace is a repo. */
  branch?: string;
  onSubmit: (text: string) => void;
  /** Runs a slash command. The UI parses it; the wiring layer executes it. */
  onCommand: (input: string) => void;
  onCancel: () => void;
  onPermission: (d: PermissionDecision) => void;
  busy: boolean;
  /** What `/resume` offers. Empty in a workspace with no earlier sessions. */
  sessions?: readonly SessionChoice[];
  /**
   * The transcript to show instead of whatever is on screen. A new array means
   * a new session: launching with `--resume`, or `/resume` switching in place.
   */
  seed?: readonly AgentEvent[];
  /** Pre-fills the composer. `--resume` with no id uses it to open the picker. */
  initialInput?: string;
};

/**
 * The screen has two regions and no fixed panes.
 *
 * Settled output is printed once into the terminal's own scrollback, so the
 * user scrolls, searches and copies it with the terminal they already know.
 * Only the live region -- the streaming message, the running tool, the prompt
 * -- redraws. The app therefore occupies exactly as many rows as it needs,
 * and there is no empty band anywhere.
 */
export function App({
  bus, cwd, model, version, backend, sandbox, branch,
  onSubmit, onCommand, onCancel, onPermission, busy,
  sessions = [], seed, initialInput,
}: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [input, setInput] = useState(initialInput ?? "");
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [cursor, setCursor] = useState(initialInput?.length ?? 0);
  const [sent, setSent] = useState<string[]>([]);
  const [recalling, setRecalling] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [helping, setHelping] = useState(false);
  // Pasted blocks, by the character standing in for them. A ref, not state:
  // every paste also moves the prompt, which is what redraws.
  const pastes = useRef(new Map<string, string>());
  const pasted = useRef(0);
  const startedAt = useRef<number | null>(null);
  const wasBusy = useRef(false);
  const lastKeyAt = useRef(0);
  const pendingSince = useRef(0);
  const term = useColumns();
  const { exit } = useApp();

  // The only connection to the runtime: a subscription. No calls in, ever.
  useEffect(() =>
    bus.on((e) => {
      if (e.type === "local.invoked" && e.command === "clear" && e.ok) {
        printed.current = [];
        consumed.current = 0;
        lastKindRef.current = null;
        dispatch({ kind: "clear" });
      }
      dispatch(e);
    }),
  [bus]);

  // When this particular request arrived, so a key already on its way to the
  // composer is not read as an answer to it.
  useEffect(() => {
    if (state.pending) pendingSince.current = Date.now();
  }, [state.pending?.requestId]);

  /**
   * Switching sessions replaces the screen.
   *
   * The printed-row bookkeeping has to go with it. `Settled` output is printed
   * once and never reprinted, so leaving `printed` populated would keep rows
   * from the session just left and count the new one's rows as already drawn.
   */
  useEffect(() => {
    if (!seed) return;
    printed.current = [];
    consumed.current = 0;
    lastKindRef.current = null;
    dispatch({ kind: "seed", events: seed });
  }, [seed]);

  useEffect(() => {
    if (wasBusy.current && !busy && queued.length > 0) {
      const [next, ...rest] = queued;
      setQueued(rest);
      onSubmit(next!);
    }
    wasBusy.current = busy;
  }, [busy, queued, onSubmit]);

  // Both of these used to own a `setInterval`, which meant two independent
  // commit streams and a timer running whenever the app was busy. They share
  // one clock now, so their ticks land in the same frame, and it stops
  // entirely when nothing is animating.
  //
  // The wave through "working" runs faster than the clock: a second is long
  // enough to look stopped. It is decoration, so it goes through `motion` and
  // disappears under NO_MOTION.
  /**
   * Subscribed exactly where it is drawn.
   *
   * Both rows are hidden while a permission is pending, and a subscription
   * that outlives what it animates keeps a timer alive for a decision that can
   * take minutes -- repainting the whole transcript every quantum to show a
   * row nobody is rendering. The screen looked still; the clock was not.
   */
  const working = busy && !state.pending;
  const phase = usePhase(working ? motion(SHIMMER_MS) : null);
  /**
   * One sweep of the border when a prompt arrives, then still.
   *
   * The keystroke guard cannot tell a deliberate `y` after a pause from an
   * answer, so the thing that closes that gap is making the prompt visibly
   * *new* rather than merely present -- and the reader it has to reach is one
   * whose attention is on their own typing, which no static treatment gets to.
   * It stops of its own accord: when the count reaches zero nothing is
   * subscribed and the screen is genuinely still.
   */
  const [arriving, setArriving] = useState(0);
  const arrival = usePhase(arriving > 0 ? motion(TICK_MS) : null);
  const requestId = state.pending?.requestId;
  useEffect(() => {
    if (requestId) setArriving(ARRIVAL_STEPS);
  }, [requestId]);
  useEffect(() => {
    setArriving((n) => (n > 0 ? n - 1 : n));
  }, [arrival]);

  // A local model can think for minutes. Without a clock the screen is
  // indistinguishable from a hang, and the first instinct is to kill it -- so
  // this is information rather than decoration and NO_MOTION leaves it alone.
  const second = usePhase(working ? 1000 : null);
  useEffect(() => {
    if (!busy) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    if (startedAt.current === null) startedAt.current = Date.now();
    // Read from the real clock rather than counting ticks, so a coalesced or
    // late tick still shows the right number.
    setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
  }, [busy, second]);

  /** Every write to the prompt goes through here, so the cursor cannot drift. */
  const put = (text: string, at = text.length) => {
    setInput(text);
    setCursor(Math.max(0, Math.min(text.length, at)));
  };

  /**
   * Browsing history keeps the half-written line.
   *
   * Losing a draft to a stray arrow is the failure that makes people stop
   * trusting the up arrow, so the draft is put back on the way out the bottom.
   */
  const recall = (step: -1 | 1) => {
    if (sent.length === 0) return;
    if (recalling === null) {
      if (step === 1) return;
      setDraft(input);
      setRecalling(sent.length - 1);
      put(sent[sent.length - 1]!);
      return;
    }
    const next = recalling + step;
    if (next < 0) return;
    if (next >= sent.length) {
      setRecalling(null);
      put(draft);
      return;
    }
    setRecalling(next);
    put(sent[next]!);
  };

  /** Submitting is the only thing that adds to history, and never twice over. */
  const remember = (text: string) => {
    setSent((h) => (h.at(-1) === text ? h : [...h, text]));
    setRecalling(null);
    setDraft("");
  };

  /** Puts a piece at the cursor, verbatim. The one place the prompt grows. */
  const write = (piece: string) => {
    setSelected(0);
    setDismissed(false);
    put(input.slice(0, cursor) + piece + input.slice(cursor), cursor + piece.length);
  };

  /**
   * Typed and pasted text take the same path in, so both are normalized and
   * both can produce a chip -- a terminal that ignores the bracketed-paste
   * request still delivers a paste here, in chunks.
   *
   * A newline typed with ctrl-j goes through `write` instead. It has to: a
   * block big enough to be worth collapsing is what earns a chip, and one
   * deliberate line break is not that.
   */
  const insert = (text: string) => {
    const clean = normalizeNewlines(text);
    if (!clean.includes("\n")) return write(clean);
    const mark = pasteMark(pasted.current++);
    pastes.current.set(mark, clean);
    write(mark);
  };

  // Paste is its own channel, so a pasted line break can never be read as a
  // pressed Enter. It stays editable text rather than becoming an attachment:
  // the point of pasting a stack trace is to type a question next to it.
  usePaste((text) => {
    if (state.pending || helping) return;
    insert(text);
  });

  useKeys((char, key) => {
    const at = Date.now();
    const sinceLastKey = at - lastKeyAt.current;
    // Updated for every key, including one this ignores, so a continuous run
    // never runs out the guard by being long enough.
    lastKeyAt.current = at;

    if (state.pending) {
      // A key is an answer only if it did not arrive in the middle of typing.
      // The prompt replaces the composer under the user's hands, so the
      // keystroke already on its way was aimed at the sentence they were
      // writing, not at a question they had not seen -- and `y` on a
      // destructive command is the worst thing a stray key can mean.
      const answering =
        sinceLastKey >= DECIDE_GUARD_MS && at - pendingSince.current >= DECIDE_GUARD_MS;
      if (!answering) return;
      if (char === "y") onPermission({ kind: "allow", scope: "once" });
      else if (char === "a") onPermission({ kind: "allow", scope: "session" });
      else if (char === "n" || key.escape) onPermission({ kind: "deny", reason: "declined" });
      return;
    }
    // The list is a reference, not a mode: whatever is pressed next closes it,
    // so nobody has to learn how to get out.
    if (helping) {
      setHelping(false);
      return;
    }
    // Ctrl-C interrupts the turn while one is running, and quits when idle --
    // but only on a second press, because the first is almost always meant to
    // stop the agent rather than lose the session.
    if (key.ctrl && char === "c") {
      if (busy) {
        onCancel();
        return;
      }
      if (confirmQuit) exit();
      else setConfirmQuit(true);
      return;
    }
    // Ctrl-D on an empty prompt is the usual way out of a REPL.
    if (key.ctrl && char === "d" && !busy && input === "") {
      exit();
      return;
    }
    if (key.escape) {
      if (busy) onCancel();
      else if (paletteOpen) setDismissed(true);
      else setConfirmQuit(false);
      return;
    }

    setConfirmQuit(false);

    // Arrows belong to whichever list is open, and to the prompt otherwise.
    if (pickerOpen) {
      if (key.upArrow) return setSelected((n) => Math.max(0, n - 1));
      if (key.downArrow) return setSelected((n) => Math.min(pickerCount - 1, n + 1));
      if (key.tab) {
        const pick = pickerAt(selected);
        if (pick) put(`/resume ${pick.id}`);
        return;
      }
    } else if (paletteOpen) {
      if (key.upArrow) return setSelected((n) => Math.max(0, n - 1));
      if (key.downArrow) return setSelected((n) => Math.min(paletteCount - 1, n + 1));
      if (key.tab) {
        const pick = paletteAt(selected);
        if (pick) put(`/${pick.name} `);
        return;
      }
    } else {
      // A multi-row prompt takes the arrows, but only while there is a row to
      // go to. Up on the first row is still history, which is what keeps that
      // binding reachable on the single-row prompt this started as -- and why
      // `rowUp` declines rather than clamping.
      if (key.upArrow) {
        const up = rowUp(input, cursor);
        return up === null ? recall(-1) : setCursor(up);
      }
      if (key.downArrow) {
        const down = rowDown(input, cursor);
        return down === null ? recall(1) : setCursor(down);
      }
    }
    if (key.ctrl && char === "p") return recall(-1);
    if (key.ctrl && char === "n") return recall(1);

    // Movement. Alt and Ctrl are both accepted for the word jumps because
    // which one a terminal sends with an arrow is a per-emulator setting.
    if (key.leftArrow) return setCursor(key.meta || key.ctrl ? wordLeft(input, cursor) : Math.max(0, cursor - 1));
    if (key.rightArrow) return setCursor(key.meta || key.ctrl ? wordRight(input, cursor) : Math.min(input.length, cursor + 1));
    if (key.meta && char === "b") return setCursor(wordLeft(input, cursor));
    if (key.meta && char === "f") return setCursor(wordRight(input, cursor));
    if (key.home || (key.ctrl && char === "a")) return setCursor(0);
    if (key.end || (key.ctrl && char === "e")) return setCursor(input.length);

    // Deletion. Each one is a slice around the cursor, so none of them can
    // move it anywhere the text does not go.
    if ((key.ctrl && char === "w") || (key.backspace && key.meta)) {
      const from = wordLeft(input, cursor);
      return put(input.slice(0, from) + input.slice(cursor), from);
    }
    if (key.ctrl && char === "u") return put(input.slice(cursor), 0);
    if (key.ctrl && char === "k") return put(input.slice(0, cursor), cursor);

    // The newline key. Shift-Enter is byte-identical to Enter in a terminal
    // without the kitty protocol, so it cannot be the one -- ctrl-j is what
    // every other agent CLI settled on for the same reason. It is the LF byte
    // itself, which is why the parser stopped reading LF as Enter.
    if (key.ctrl && char === "j") return write("\n");

    if (key.return) {
      // A highlighted session runs straight away. There is nothing to complete
      // -- the id IS the argument, so completing it would just ask again.
      if (pickerOpen) {
        const pick = pickerAt(selected);
        if (pick) {
          const full = `/resume ${pick.id}`;
          put("");
          setSelected(0);
          remember(full);
          onCommand(full);
          return;
        }
      }
      // Enter takes the highlighted command. One that needs an argument is
      // completed rather than run, because running it would only produce its
      // usage line.
      if (paletteOpen) {
        const pick = paletteAt(selected);
        if (pick) {
          const typedArgs = input.trim().slice(1).split(" ").slice(1).join(" ");
          if (pick.takes && !typedArgs) {
            put(`/${pick.name} `);
            return;
          }
          const full = `/${pick.name}${typedArgs ? ` ${typedArgs}` : ""}`;
          put("");
          setSelected(0);
          remember(full);
          onCommand(expandPastes(full, pastes.current));
          return;
        }
      }
      const text = input.trim();
      if (!text) return;
      put("");
      remember(text);
      // A turn can run for minutes. Taking the keyboard away for that long
      // means the next instruction has to be held in the user's head until
      // the agent is finished, so it is queued instead.
      // A command is the user acting on the session, so it runs immediately
      // even mid-turn; only instructions for the model wait their turn.
      // History keeps the chip, so a recalled line still reads as one line.
      // Only what leaves the client is expanded.
      const full = expandPastes(text, pastes.current);
      if (isCommand(text)) onCommand(full);
      else if (busy) setQueued((q) => [...q, full]);
      else onSubmit(full);
      return;
    }
    if (key.backspace) {
      if (cursor === 0) return;
      setSelected(0);
      setDismissed(false);
      return put(input.slice(0, cursor - 1) + input.slice(cursor), cursor - 1);
    }
    if (key.delete) {
      if (cursor >= input.length) return;
      setSelected(0);
      return put(input.slice(0, cursor) + input.slice(cursor + 1), cursor);
    }
    // A bare "?" is a question when there is a line to attach it to, and a
    // request for the bindings when there is not.
    if (char === "?" && input === "" && !key.ctrl && !key.meta) {
      setHelping(true);
      return;
    }
    // A terminal that ignores the bracketed-paste request still delivers a
    // paste here, in chunks, so this path normalizes too.
    if (char && !key.ctrl && !key.meta) insert(char);
  });

  /** What a pasted block is drawn as. Its size is the only useful thing left. */
  const chipLabel = (mark: string) => {
    const lines = (pastes.current.get(mark) ?? "").split("\n").length;
    return `[Pasted text #${pasteId(mark)} +${lines} lines]`;
  };

  /**
   * `/resume ` opens the session list where the command list would be.
   *
   * The two cannot both be open: once the command is named and a space typed,
   * the thing being chosen is a session, and the argument filters it by id or
   * by what the session was first asked. This is why `/resume` completes to
   * `/resume ` rather than running -- the space is what opens the picker.
   */
  const resumeArg = /^\/resume\s(.*)$/.exec(input)?.[1] ?? null;
  const matchingSessions = resumeArg === null
    ? []
    : sessions.filter(
        (s) =>
          s.id.startsWith(resumeArg) ||
          s.label.toLowerCase().includes(resumeArg.toLowerCase()),
      );
  const pickerOpen = matchingSessions.length > 0 && !dismissed;
  const pickerCount = Math.min(matchingSessions.length, PALETTE_ROWS);
  const pickerAt = (n: number) => matchingSessions[n];

  const matchingCommands = input.startsWith("/")
    ? COMMANDS.filter((c) => c.name.startsWith(input.slice(1).split(" ")[0] ?? ""))
    : [];
  const paletteOpen = matchingCommands.length > 0 && !dismissed && !pickerOpen;
  const paletteCount = Math.min(matchingCommands.length, PALETTE_ROWS);
  const paletteAt = (n: number) => matchingCommands[n];

  // An item is settled once nothing can change it again. Settled lines are
  // append-only for Static, which holds because a gap depends only on an item
  // and the one before it.
  const settledCount = countSettled(state.items);
  const banner = useMemo(
    () => bannerLines({ version, model, backend, sandbox, cwd: shortenPath(cwd, term - 6) }),
    [version, model, backend, sandbox, cwd, term],
  );
  /**
   * Settled lines accumulate; they are never recomputed.
   *
   * Static prints what it has not printed before and tracks that by count, so
   * the list it is given has to be append-only in the strictest sense: the
   * same lines, in the same order, forever. Deriving it from the current
   * terminal width broke that -- on resize every line was re-wrapped, the
   * count changed, and Ink printed the difference as new content, repeating
   * the transcript down the screen.
   *
   * Re-wrapping printed history is impossible anyway: those rows belong to the
   * terminal's scrollback now, which is also why a real terminal does not
   * reflow its own. New lines are wrapped at whatever width is current when
   * they arrive.
   */
  const printed = useRef<L[]>([]);
  const consumed = useRef(0);
  const lastKindRef = useRef<ViewItem["kind"] | null>(null);

  if (printed.current.length === 0) printed.current = [...banner];
  if (settledCount > consumed.current) {
    const fresh = state.items.slice(consumed.current, settledCount);
    printed.current = [...printed.current, ...renderRun(fresh, term, lastKindRef.current)];
    lastKindRef.current = state.items[settledCount - 1]?.kind ?? lastKindRef.current;
    consumed.current = settledCount;
  }
  const settled = printed.current;

  const lastSettled = state.items[settledCount - 1]?.kind ?? null;
  const live = renderRun(state.items.slice(settledCount), term, lastSettled);

  const where = branch ? `${basename(cwd)} ${branch}` : basename(cwd);
  const usage = `${sandbox}  \u00b7  ${fmt(state.usage.input)}\u2191 ${fmt(state.usage.output)}\u2193`;

  // What this session is about, taken from the request that started it -- far
  // easier to recognise than an id. It is the only elastic field in the
  // footer, so it takes whatever the fixed ones leave and disappears when
  // that is nothing, rather than pushing the line past the terminal.
  const title = useMemo(() => {
    const first = state.items.find((i) => i.kind === "user");
    if (!first || first.kind !== "user") return "";
    const room = term - GUTTER * 2 - model.length - where.length - usage.length - 14;
    if (room < 12) return "";
    const words = first.text.trim().split(/\s+/).slice(0, 8).join(" ");
    return words.length > room ? words.slice(0, room - 1) + "\u2026" : words;
  }, [state.items, term, model, where, usage]);

  /**
   * The commands matching what has been typed so far.
   *
   * Shown as a list with what each one does, rather than a row of bare names:
   * the names alone only help someone who already knows them, which is not who
   * needs the hint. Capped, because this sits in the live frame and that is
   * redrawn whole on every keystroke.
   */
  const palette = paletteOpen ? matchingCommands.slice(0, PALETTE_ROWS) : [];
  const moreCommands = matchingCommands.length - palette.length;
  const picker = pickerOpen ? matchingSessions.slice(0, PALETTE_ROWS) : [];
  const moreSessions = matchingSessions.length - picker.length;

  return (
    <>

      <Settled items={settled} render={(line, i) => <Row key={i} line={line} />} />

      <Stack direction="column">
        {live.map((l, i) => (
          <Row key={`live-${i}`} line={l} />
        ))}

        {state.items.length > 0 && <Label> </Label>}

        {busy && !state.pending && (
          <Stack direction="row" padX={GUTTER}>
            <Label dim>{"\u00b7 "}</Label>
            <Label bold>
              {shimmer("working", phase).map((sp, i) => (
                <Label key={i} color={sp.color}>{sp.text}</Label>
              ))}
            </Label>
            <Label dim>{`  ${formatElapsed(elapsed)} \u00b7 esc to interrupt`}</Label>
          </Stack>
        )}

        {queued.map((q, i) => (
          <Stack key={i} direction="row" padX={GUTTER}>
            {/* A queued line is a request that has not started, so it takes
                the request's marker rather than a glyph of its own. The word
                stays: the marker says whose line it is, and only the word says
                why it is sitting there. */}
            <Label dim>{"\u203a queued  "}</Label>
            <Label dim>{clip(q, term - GUTTER - 12)}</Label>
          </Stack>
        ))}

        {state.pending ? (
          <Stack
            direction="column"
            padX={GUTTER}
            border
            borderSides="y"
            borderColor={arriving > 0 && (ARRIVAL_STEPS - arriving) % 4 < 2 ? "white" : "yellow"}
          >
            {/* The tool's name is what the transcript two rows up already
                says, and it is not what is being decided. The command is. */}
            <Label>
              <Label bold color="yellow">{"approve  "}</Label>
              {state.pending.radius.command
                ? highlightCommand(clip(state.pending.radius.command, term - 14))
                    .map((sp, i) => (
                      <Label key={i} color={sp.color} dim={sp.dim}>{sp.text}</Label>
                    ))
                : <Label bold>{state.pending.tool}</Label>}
            </Label>
            {/* What it will reach is the only thing here that is not already
                on screen, so it is the only thing that needs saying twice. */}
            {radiusLines(state.pending.radius)
              .filter((l) => l !== state.pending?.radius.command)
              .map((l, i) => (
                <Label key={i} dim>{`  ${clip(l, term - 6)}`}</Label>
              ))}
            <Label>{"[y] once    [a] session    [n] deny or esc"}</Label>
          </Stack>
        ) : (
          <Stack
            direction="column"
            padX={GUTTER}
            border
            borderSides="y"
            borderDim={!confirmQuit}
            borderColor={confirmQuit ? "yellow" : undefined}
          >
            {confirmQuit ? (
              <Stack direction="row">
                <Label color="yellow">{"! "}</Label>
                <Label color="yellow">ctrl-c again to exit, any key to stay</Label>
              </Stack>
            ) : (
              composerRows(input, cursor, chipLabel).map((row, r) => (
                <Stack key={r} direction="row">
                  {/* Only the first row is marked, and the rest are indented
                      to the marker's width so a multi-row prompt reads as one
                      block of text rather than as a list of entries. */}
                  <Label>{r === 0 ? "\u203a " : "  "}</Label>
                  <Label>
                    {row.pieces.map((piece, i) => (
                      <Label
                        key={i}
                        bg={piece.cursor ? CURSOR : undefined}
                        color={piece.cursor ? "black" : undefined}
                      >
                        {piece.text}
                      </Label>
                    ))}
                    {/* At the end of a row the cursor is a bar, as it has
                        always been. Inside the row it is a block on whatever
                        it sits on: a bar between two characters reads as one
                        of them, and on a chip it would read as a character of
                        the label. */}
                    {row.caret && <Label>{"\u258f"}</Label>}
                    {/* The hint is not text you typed, so it must not look
                        like it. An explicit grey reads as absent in a way SGR
                        dim does not -- dim white is still close to white on
                        many themes. */}
                    {input === "" && (
                      <Label color="gray">
                        {busy ? " type to queue the next instruction" : " describe a change, or ask about the code"}
                      </Label>
                    )}
                  </Label>
                </Stack>
              ))
            )}
          </Stack>
        )}

        {picker.length > 0 && (
          <Stack direction="column" padX={GUTTER}>
            {picker.map((s, i) => {
              const on = i === selected;
              return (
                <Label key={s.id}>
                  <Label color={on ? "cyan" : undefined}>{on ? "\u203a " : "  "}</Label>
                  <Label bg={on ? BAND : undefined} color="cyan" bold={on}>
                    {s.id.padEnd(ID_COLUMN)}
                  </Label>
                  <Label bg={on ? BAND : undefined} dim={!on}>
                    {clip(s.label, term - GUTTER - ID_COLUMN - 4)}
                  </Label>
                </Label>
              );
            })}
            {moreSessions > 0 && (
              <Label dim>{`${" ".repeat(ID_COLUMN + 2)}\u2026 ${moreSessions} older`}</Label>
            )}
          </Stack>
        )}

        {palette.length > 0 && (
          <Stack direction="column" padX={GUTTER}>
            {palette.map((c, i) => {
              const on = i === selected;
              return (
                <Label key={c.name}>
                  <Label>{on ? "\u203a " : "  "}</Label>
                  <Label bg={on ? BAND : undefined} color="cyan" bold={on}>
                    {`/${c.name}${c.takes ? ` ${c.takes}` : ""}`.padEnd(NAME_COLUMN)}
                  </Label>
                  <Label bg={on ? BAND : undefined} dim={!on}>
                    {clip(c.summary, term - GUTTER - NAME_COLUMN - 4)}
                  </Label>
                </Label>
              );
            })}
            {moreCommands > 0 && (
              <Label dim>{`${" ".repeat(NAME_COLUMN + 2)}\u2026 ${moreCommands} more`}</Label>
            )}
          </Stack>
        )}

        {helping && (
          <Stack direction="column" padX={GUTTER}>
            {SHORTCUTS.map((group) => (
              <Stack key={group.title} direction="column">
                <Label> </Label>
                <Label bold>{group.title}</Label>
                {group.items.map((it) => (
                  <Label key={`${group.title}-${it.keys}`}>
                    <Label>{it.keys.padEnd(KEY_COLUMN)}</Label>
                    <Label dim>{clip(it.does, term - GUTTER - KEY_COLUMN - 2)}</Label>
                  </Label>
                ))}
              </Stack>
            ))}
            <Label> </Label>
            <Label dim>{"any key to dismiss"}</Label>
            <Label> </Label>
          </Stack>
        )}

        <Stack direction="row" padX={GUTTER} align="between">
          <Label>
            <Label dim>{model}</Label>
            <Label dim>{"  \u00b7  "}</Label>
            <Label dim>{where}</Label>
            {title && (
              <>
                <Label dim>{"  \u00b7  "}</Label>
                <Label dim>{title}</Label>
              </>
            )}
          </Label>
          <Label dim>{usage}</Label>
        </Stack>
      </Stack>
    </>
  );
}

/** One step off the terminal's own background: enough to read as a field. */
const BAND = "#2a2a2a";

/** Light enough to read as the terminal's own cursor rather than a highlight. */
const CURSOR = "#c8c8c8";

/** Two pulses of the border, then done. Eight quanta is a little over half a second. */
const ARRIVAL_STEPS = 8;

/** Width of the command column, so the descriptions line up. */
const NAME_COLUMN = 22;

/** Width of the session id column, so the first prompts line up. */
const ID_COLUMN = 10;

/** Width of the key column in the shortcut list. */
const KEY_COLUMN = 18;


/**
 * The shimmer runs at the clock's quantum: one step, the fastest anything here
 * moves. It was 90ms, tuned by eye, and a request for 90 would round up to two
 * steps and halve the speed -- so it asks for the quantum itself, which is
 * also what other terminal UIs settle on for a running indicator.
 */
const SHIMMER_MS = TICK_MS;

/** The live frame is redrawn on every keystroke, so the list is capped. */
const PALETTE_ROWS = 8;

/**
 * How long a permission key is ignored for after typing or after the prompt.
 *
 * Keystrokes closer together than this are a run, and a run is someone
 * writing rather than someone answering. The parser already batches a fast run
 * into one event, so `char` is "yes" and never matches "y"; this covers the
 * slow-typing case, where each character arrives on its own.
 *
 * It closes the in-flight keystroke and the run that follows it. It cannot
 * close a `y` pressed deliberately after a pause, because nothing at this
 * layer can tell that from an answer -- which is the argument for the prompt
 * also being visibly new rather than merely present.
 *
 * Discarded, never queued. Queueing applies the stray key the moment the
 * guard lifts, which is the same bug one tick later.
 */
const DECIDE_GUARD_MS = 250;

/** The one place a depth becomes columns. */
function Row({ line }: { line: L }) {
  const pad = " ".repeat(GUTTER + (line.depth ?? 0) * STEP);
  // A rule carries no text, so it has to be handled before the blank-row
  // guard below -- otherwise it renders as an empty line.
  if (line.rule) {
    return <Label dim>{"\u2500".repeat(Math.max(0, line.width ?? 0))}</Label>;
  }
  // An empty Text renders no row at all, so a blank line is a single space.
  if (!line.text) return <Label> </Label>;
  if (line.md) return <Markdown line={line.text} indent={pad} color={line.color} dim={line.dim} />;
  if (line.band) {
    return (
      <Label bg={BAND}>
        {pad}
        {(line.spans ?? [{ text: line.text }]).map((sp, i) => (
          <Label key={i} bg={BAND} color={sp.color} bold={sp.bold} dim={sp.dim}>
            {sp.text}
          </Label>
        ))}
        {" ".repeat(Math.max(0, (line.width ?? 0) - pad.length - line.text.length))}
      </Label>
    );
  }
  if (line.spans) {
    return (
      <Label>
        {pad}
        {line.spans.map((s, i) => (
          <Label key={i} color={s.color} dim={s.dim} bold={s.bold}>
            {s.text}
          </Label>
        ))}
      </Label>
    );
  }
  return (
    <Label color={line.color} dim={line.dim} bold={line.bold}>
      {pad + line.text}
    </Label>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Thousands separator without the noise of full locale formatting. */
function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/**
 * Vertical rhythm.
 *
 * A blank row is the only separator this UI has, so it is spent where the
 * reader changes what they are doing: starting a new exchange, or moving from
 * the agent's work back to its answer. Consecutive tool calls are one
 * continuous action and get none -- spacing them out is what turns a session
 * into a scroll.
 */
function gapBefore(prev: ViewItem["kind"] | null, next: ViewItem["kind"]): number {
  if (prev === null) return 0;
  if (next === "user") return 0;
  // The request and the work it triggered are different things; running them
  // together makes the agent's first move look like part of the sentence.
  if (prev === "user") return 1;
  if (next === "assistant" && prev !== "assistant") return 1;
  if (next === "compaction" || prev === "compaction") return 1;
  return 0;
}

function renderRun(items: ViewItem[], term: number, startingAfter: ViewItem["kind"] | null): L[] {
  const out: L[] = [];
  let prev = startingAfter;
  for (const item of items) {
    // A new request closes the exchange before it with a rule, which reads
    // more clearly than a blank row for the same one-row cost.
    if (prev !== null && item.kind === "user") {
      out.push(BLANK, { text: "", rule: true, width: term }, BLANK);
    }
    for (let i = 0; i < gapBefore(prev, item.kind); i++) out.push(BLANK);
    out.push(...renderItem(item, term));
    prev = item.kind;
  }
  return out;
}

/**
 * How many leading items can never change again.
 *
 * The loop emits strictly sequentially: once a later item exists, the one
 * before it is finished, whatever its own flags say. Only the last item can
 * still be in progress.
 *
 * The previous rule stopped at the first item that did not look finished, so a
 * single reasoning block that never received its completion event pinned
 * every item after it in the live region. That region is redrawn whole on each
 * frame, so it grew until it was taller than the terminal, at which point Ink
 * could no longer erase what it had drawn and the last line repeated down the
 * screen. Bounding the live region to one item removes the cause rather than
 * the symptom.
 */
export function countSettled(items: ViewItem[]): number {
  if (items.length === 0) return 0;
  const last = items[items.length - 1]!;
  const lastIsLive =
    (last.kind === "assistant" && last.streaming) ||
    (last.kind === "tool" && last.running) ||
    (last.kind === "reasoning" && !last.done);
  return lastIsLive ? items.length - 1 : items.length;
}

function renderItem(i: ViewItem, term: number): L[] {
  switch (i.kind) {
    // The request is the loudest thing on screen: it is what everything below
    // it is answering, and the eye should find it without searching.
    // The request is banded rather than bolded: it is a different kind of
    // thing from everything under it, not a louder version of the same thing.
    case "user": {
      const w = measureAt(DEPTH.said, term) - 2;
      return wrap(i.text, w).map((t, n) => ({
        ...styled(
          DEPTH.said,
          n === 0 ? { text: "\u203a " } : { text: "  " },
          { text: t },
        ),
        band: true,
        width: term,
      }));
    }

    case "assistant":
      return wrap(i.text, measureAt(DEPTH.said, term)).map((t) => ({
        text: t,
        depth: DEPTH.said,
        md: true,
      }));

    case "reasoning":
      return [{
        text: `  ${i.done ? `thought for ${i.chars.toLocaleString()} chars` : "thinking\u2026"}`,
        depth: DEPTH.did,
        dim: true,
      }];

    case "tool": {
      const w = measureAt(DEPTH.did, term);
      // Three weights on one line: a coloured mark carries status, the tool
      // name carries what kind of thing happened, and the argument -- the
      // longest part and the least often needed -- recedes.
      /**
       * The mark column answers the one question a reader has scrolling back:
       * what did it change in my files.
       *
       * A tick used to mean "the call returned", which is the least
       * interesting thing on the row and made a read and a write identical --
       * distinguishable only by four characters of English, in colour and in
       * monochrome alike. `+` and `~` are diff vocabulary, so they need no
       * legend, and the distinction survives with colour switched off, which
       * is where hierarchy is supposed to live.
       *
       * `deleted` is in the event's union and no tool produces one, so there
       * is deliberately no treatment for it: drawing a state that cannot occur
       * is drawing something nobody can check.
       */
      const changed = i.changed ?? [];
      const mark = i.running ? "\u00b7"
        : i.ok === false ? "\u2717"
        : changed.length === 0 ? "\u2713"
        : changed.some((c) => c.change === "created") ? "+"
        : "~";
      // Running is not a name, and cyan means a name. The mark recedes until
      // it can say something: the shimmer two rows down already says alive.
      const markColor = i.running ? undefined : i.ok === false ? "red" : "green";
      const verb = verbFor(i.name);
      const summary = i.args !== undefined ? summariseCall(i.name, i.args) : "";
      const room = w - mark.length - verb.length - 3;
      const shown = summary ? clip(summary, Math.max(8, room)) : "";
      const out: L[] = [
        styled(
          DEPTH.did,
          { text: `${mark} `, color: markColor, dim: i.running },
          { text: verb, bold: true, color: i.ok === false ? "red" : undefined },
          ...(shown
            ? i.name === "shell"
              ? [{ text: " " }, ...highlightCommand(shown)]
              : [{ text: ` ${shown}`, color: "cyan" as const }]
            : []),
        ),
      ];

      const body = i.running ? i.output : i.result;
      if (body?.trim()) {
        const dw = measureAt(DEPTH.detail, term);
        const { lines, hidden } = outputLines(body);
        // While running, the tail is what is happening; once finished, the
        // head is what happened.
        const shown = i.running ? lines.slice(-5) : lines;
        shown.forEach((l, n) => {
          out.push(
            styled(
              DEPTH.detail,
              { text: n === 0 ? "\u2514 " : "  ", dim: true },
              { text: clip(l, dw - 2), dim: true },
            ),
          );
        });
        if (!i.running && hidden > 0) {
          out.push({ text: `  \u2026 +${hidden} lines`, depth: DEPTH.detail, dim: true });
        }
      }
      return out;
    }

    case "error":
      return wrap(i.text, measureAt(DEPTH.did, term) - 2).map((t, n) => ({
        text: (n === 0 ? "\u2717 " : "  ") + t,
        depth: DEPTH.did,
        color: "red" as const,
      }));

    case "compaction":
      return [{
        text: clip(`\u22ef compacted ${i.dropped} events \u2014 ${i.summary}`, measureAt(DEPTH.did, term)),
        depth: DEPTH.did,
      }];

    // The user ran this, not the agent, so it gets its own mark rather than
    // the tool tick -- attribution is the whole point of showing it.
    case "local": {
      const w = measureAt(DEPTH.did, term);
      const out: L[] = [
        styled(
          DEPTH.did,
          { text: "\u203a ", color: i.ok ? undefined : "red" },
          { text: `/${i.command}`, bold: true, color: i.ok ? undefined : "red" },
          i.args ? { text: ` ${clip(i.args, w - i.command.length - 4)}`, dim: true } : null,
        ),
      ];
      // Depth two reads as "what came back" wherever it appears, so a command's
      // output opens with the same mark a tool's does. Two treatments at one
      // nesting level is two visual languages for one idea.
      const dw = measureAt(DEPTH.detail, term);
      i.output.split("\n").forEach((line, n) => {
        out.push(
          styled(
            DEPTH.detail,
            { text: n === 0 ? "\u2514 " : "  ", dim: true },
            { text: clip(line, dw - 2), dim: true },
          ),
        );
      });
      return out;
    }
  }
}
