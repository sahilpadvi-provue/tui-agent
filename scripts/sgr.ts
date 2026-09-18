/**
 * A colour, in whichever encoding this terminal gets.
 *
 * The gates that pin a colour were written against `48;5;235` and failed on any
 * terminal advertising `COLORTERM=truecolor`, where the same grey is correctly
 * emitted as `48;2;42;42;42`. The renderer was right and the assertions were
 * describing one of its two outputs -- which is worse than a plain bug, because
 * these gates stand in for unit tests on the colour code and they were green on
 * the machine that wrote them.
 *
 * Both forms are named here rather than derived from the renderer, so the
 * assertion still pins which grey it wants. Deriving it would make the gate
 * agree with whatever the code does.
 */
export function painted(layer: 38 | 48, index: number, hex: string): (code: string) => boolean {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const rgb = `${layer};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  const short = `${layer};5;${index}`;
  return (code) => code.includes(short) || code.includes(rgb);
}

/** The greys and whites the gates pin, so the two do not drift apart. */
export const DARK_BAND = painted(48, 235, "#2a2a2a");
export const LIGHT_BAND = painted(48, 254, "#e8e8e8");
export const SHIMMER_HEAD = painted(38, 231, "#ffffff");

/** Any colour at all, in either encoding. */
export const anyColour = (code: string): boolean => /[34]8;[25];/.test(code);
