/**
 * Raw stdin to key events.
 *
 * Deliberately a subset: what `App` actually reads, which is printable
 * characters, Enter, Backspace, Escape and the two control keys. Arrow and
 * function keys parse to a recognised-but-empty event rather than falling
 * through as literal escape bytes, because a stray `[A` appearing in the
 * composer is worse than a key doing nothing.
 *
 * Ink's own `parse-keypress.js` is four hundred lines. The gap between that
 * and this is the honest remaining cost of leaving Ink, and it is why nothing
 * here claims to be finished.
 */

import type { Key, KeyEvent } from "../backend.ts";

export type { Key, KeyEvent };

const NONE: Key = {
  ctrl: false, meta: false, shift: false, escape: false, return: false,
  backspace: false, delete: false, upArrow: false, downArrow: false,
  leftArrow: false, rightArrow: false, tab: false, home: false, end: false,
};

const key = (over: Partial<Key>): Key => ({ ...NONE, ...over });

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Turns bracketed paste on. Without it a pasted newline is an Enter press. */
export const ENABLE_PASTE = "\x1b[?2004h";
export const DISABLE_PASTE = "\x1b[?2004l";

/**
 * Home and End have two encodings each. Terminals disagree about which they
 * send, and `xterm` sends different ones depending on whether the keypad is in
 * application mode, so both forms are accepted.
 */
const SEQUENCES: Record<string, Partial<Key>> = {
  A: { upArrow: true },
  B: { downArrow: true },
  C: { rightArrow: true },
  D: { leftArrow: true },
  H: { home: true },
  F: { end: true },
  "1~": { home: true },
  "7~": { home: true },
  "4~": { end: true },
  "8~": { end: true },
  "3~": { delete: true },
};

export type Parsed = { events: KeyEvent[]; pastes: string[] };

function parseChunk(
  data: string,
  carry: string | null,
  swallowLf: boolean,
): Parsed & { carry: string | null; swallowLf: boolean } {
  const events: KeyEvent[] = [];
  const pastes: string[] = [];

  let i = 0;
  let pending = carry;
  let swallow = false;

  // A paste split across two reads arrives as a body with no terminator, then
  // a terminator with the rest. Holding the body until the terminator lands is
  // what stops the newline inside it from being read as Enter.
  if (pending !== null) {
    const end = data.indexOf(PASTE_END);
    if (end === -1) return { events: [], pastes: [], carry: pending + data, swallowLf: false };
    pastes.push(pending + data.slice(0, end));
    pending = null;
    i = end + PASTE_END.length;
  }

  // The tail of a CRLF pair that was split across two reads. Its CR already
  // went out as Enter, so this LF is not a ctrl-j.
  if (swallowLf && i === 0 && data.startsWith("\n")) i = 1;

  // Printable characters are emitted as one event per run, not one per
  // character. A handler that rebuilds the line from its own state reads that
  // state once per event, so splitting "abc" into three would have all three
  // computed from the same stale value and only the last would survive. Fast
  // typing and a paste into a terminal that ignores bracketed paste both
  // arrive as one chunk, which is exactly this case.
  let runStart = -1;
  const flushRun = () => {
    if (runStart === -1) return;
    events.push({ char: data.slice(runStart, i), key: NONE });
    runStart = -1;
  };

  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      flushRun();
      const end = data.indexOf(PASTE_END, i);
      // An unterminated paste means the chunk split mid-paste. Taking the rest
      // is wrong only in that the tail arrives as a second paste.
      if (end === -1) {
        pending = data.slice(i + PASTE_START.length);
        i = data.length;
        continue;
      }
      pastes.push(data.slice(i + PASTE_START.length, end));
      i = end + PASTE_END.length;
      continue;
    }

    const ch = data[i]!;

    if (ch === "\x1b") {
      flushRun();
      const seq = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(data.slice(i));
      if (seq) {
        const code = seq[2] === "~" ? `${seq[1]}~` : seq[2] ?? "";
        // Alt sends the same sequence with a ";3" modifier, and the word jumps
        // are bound to it.
        const meta = (seq[1] ?? "").endsWith(";3");
        events.push({ char: "", key: key({ ...(SEQUENCES[code] ?? {}), meta }) });
        i += seq[0].length;
        continue;
      }
      // ESC followed by a letter is how a terminal sends Alt with that letter.
      const next = data[i + 1];
      if (next !== undefined && next >= " " && next !== "\x7f") {
        events.push({ char: next, key: key({ meta: true }) });
        i += 2;
        continue;
      }
      events.push({ char: "", key: key({ escape: true }) });
      i += 1;
      continue;
    }

    if (ch >= " " && ch !== "\x7f") {
      if (runStart === -1) runStart = i;
      i += 1;
      continue;
    }

    flushRun();
    if (ch === "\x7f") {
      events.push({ char: "", key: key({ backspace: true }) });
    } else if (ch === "\r") {
      // LF alone is deliberately not Enter. It is ctrl-j, the newline key, and
      // it falls through to the control branch below to become one.
      //
      // CRLF is one line break rather than Enter followed by one. That pair is
      // what a Windows clipboard, a lot of web content, and an SSH session
      // from a Windows host deliver, and on a terminal that ignores bracketed
      // paste reading its CR as Enter submitted the paste at its first line
      // break. `normalizeNewlines` covers the same thing on the paste channel;
      // this is the typed channel catching up.
      if (data[i + 1] === "\n") {
        events.push({ char: "j", key: key({ ctrl: true }) });
        i += 1;
      } else {
        events.push({ char: "", key: key({ return: true }) });
        // A lone CR cannot wait to find out whether an LF follows in the next
        // read. A real Enter press is usually the whole chunk, so holding it
        // back would mean the prompt did nothing until the next keystroke --
        // far worse than the case it would fix. The Enter goes out now and any
        // LF opening the next chunk is swallowed, which confines a
        // boundary-split CRLF to submitting early instead of also leaving a
        // stray newline in the prompt that follows.
        //
        // A CR with no LF after it is genuinely indistinguishable from Enter,
        // so a pre-OSX CR-only paste is not fixable here and is not claimed to
        // be. Bracketed paste is the real defence and `mount` asks for it.
        if (i === data.length - 1) swallow = true;
      }
    } else if (ch === "\b") {
      events.push({ char: "", key: key({ backspace: true }) });
    } else if (ch === "\t") {
      events.push({ char: "", key: key({ tab: true }) });
    } else {
      // Ctrl-A is 0x01, so the letter is the code plus 0x60.
      events.push({
        char: String.fromCharCode(ch.charCodeAt(0) + 0x60),
        key: key({ ctrl: true }),
      });
    }
    i += 1;
  }
  flushRun();

  return { events, pastes, carry: pending, swallowLf: swallow };
}

/**
 * Stateful across reads, because a paste is.
 *
 * An escape sequence split across two reads is still mis-parsed; Ink resolves
 * that with a short timer. Not done here, and not yet needed: the sequences
 * this parses are at most six bytes.
 */
export class Parser {
  #carry: string | null = null;
  #swallowLf = false;

  push(data: string): Parsed {
    const { events, pastes, carry, swallowLf } = parseChunk(data, this.#carry, this.#swallowLf);
    this.#carry = carry;
    this.#swallowLf = swallowLf;
    return { events, pastes };
  }
}
