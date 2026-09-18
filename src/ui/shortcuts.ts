/**
 * The bindings, as the user sees them.
 *
 * This table is display only -- `App.tsx` dispatches on keys directly, because
 * a lookup table that maps a key to a closure would be a layer of indirection
 * over a switch with one caller. Keeping it here rather than in `commands/`
 * is what stops the runtime from importing the client: a binding is a property
 * of this screen, not of the agent.
 */
export type Shortcut = { readonly keys: string; readonly does: string };
export type ShortcutGroup = { readonly title: string; readonly items: readonly Shortcut[] };

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: "moving",
    items: [
      { keys: "← →", does: "by character" },
      { keys: "⌥← ⌥→", does: "by word" },
      { keys: "ctrl-a / home", does: "start of line" },
      { keys: "ctrl-e / end", does: "end of line" },
      { keys: "\u2191 \u2193", does: "by row, once the prompt has more than one" },
    ],
  },
  {
    title: "editing",
    items: [
      { keys: "ctrl-w", does: "delete the word before the cursor" },
      { keys: "ctrl-u", does: "delete back to the start" },
      { keys: "ctrl-k", does: "delete to the end" },
      { keys: "ctrl-j", does: "insert a line break" },
      { keys: "del", does: "delete the character under the cursor" },
    ],
  },
  {
    title: "history",
    items: [
      { keys: "↑ ↓", does: "previous / next thing you sent" },
      { keys: "ctrl-p / ctrl-n", does: "the same" },
    ],
  },
  {
    title: "commands",
    items: [
      { keys: "/", does: "open the list" },
      { keys: "↑ ↓", does: "move through it" },
      { keys: "tab", does: "complete the highlighted one" },
      { keys: "enter", does: "run it, or complete it if it needs an argument" },
      { keys: "esc", does: "close the list" },
    ],
  },
  {
    title: "session",
    items: [
      { keys: "enter", does: "send, or queue it while the agent is working" },
      { keys: "esc", does: "interrupt the turn" },
      { keys: "ctrl-c", does: "interrupt; again on an idle prompt to quit" },
      { keys: "ctrl-d", does: "quit from an empty prompt" },
      { keys: "?", does: "this list, from an empty prompt" },
    ],
  },
];
