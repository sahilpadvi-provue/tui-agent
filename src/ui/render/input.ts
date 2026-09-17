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

export type Key = {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  escape: boolean;
  return: boolean;
  backspace: boolean;
  delete: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  tab: boolean;
};

export type KeyEvent = { char: string; key: Key };

const NONE: Key = {
  ctrl: false, meta: false, shift: false, escape: false, return: false,
  backspace: false, delete: false, upArrow: false, downArrow: false,
  leftArrow: false, rightArrow: false, tab: false,
};

const key = (over: Partial<Key>): Key => ({ ...NONE, ...over });

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Turns bracketed paste on. Without it a pasted newline is an Enter press. */
export const ENABLE_PASTE = "\x1b[?2004h";
export const DISABLE_PASTE = "\x1b[?2004l";

const ARROWS: Record<string, Partial<Key>> = {
  A: { upArrow: true },
  B: { downArrow: true },
  C: { rightArrow: true },
  D: { leftArrow: true },
};

export type Parsed = { events: KeyEvent[]; pastes: string[] };

export function parse(data: string): Parsed {
  const events: KeyEvent[] = [];
  const pastes: string[] = [];

  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i);
      // An unterminated paste means the chunk split mid-paste. Taking the rest
      // is wrong only in that the tail arrives as a second paste.
      const stop = end === -1 ? data.length : end;
      pastes.push(data.slice(i + PASTE_START.length, stop));
      i = end === -1 ? data.length : end + PASTE_END.length;
      continue;
    }

    const ch = data[i]!;

    if (ch === "\x1b") {
      const seq = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(data.slice(i));
      if (seq) {
        const arrow = ARROWS[seq[2] ?? ""];
        events.push({ char: "", key: key(arrow ?? {}) });
        i += seq[0].length;
        continue;
      }
      events.push({ char: "", key: key({ escape: true }) });
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      events.push({ char: "", key: key({ return: true }) });
    } else if (ch === "\x7f" || ch === "\b") {
      events.push({ char: "", key: key({ backspace: true }) });
    } else if (ch === "\t") {
      events.push({ char: "", key: key({ tab: true }) });
    } else if (ch < " ") {
      // Ctrl-A is 0x01, so the letter is the code plus 0x60.
      events.push({
        char: String.fromCharCode(ch.charCodeAt(0) + 0x60),
        key: key({ ctrl: true }),
      });
    } else {
      events.push({ char: ch, key: NONE });
    }
    i += 1;
  }

  return { events, pastes };
}
