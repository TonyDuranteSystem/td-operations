/**
 * TD Social — clean a piece of text that comes from outside before it is stored or shown (pure; dev job 2072bc3e, Step 2).
 *
 * Used for the phone's own name today and for lock-screen names later (Step 2 pull request C2). A person (or a client) can type
 * anything as a name, so a name is never trusted as written: control characters, line breaks and the characters that reverse text
 * direction are removed, runs of spaces become one, and the result is cut by WHOLE characters (a cut never splits an emoji).
 *
 * The unsafe characters are listed as numbers (not typed into the source) so no invisible character can hide in this file.
 */

// [first, last] code points: C0 and C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// direction marks, line / paragraph separators and direction embeddings / overrides, invisible operators and direction isolates,
// the byte-order mark, interlinear annotation marks, lone surrogate halves (Apple refuses a payload that is not valid text).
// The zero-width NON-joiner and JOINER (U+200C, U+200D) are KEPT: they are part of real names (Persian, many emoji) and cannot reverse text direction.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xd800, 0xdfff],
  [0xfff9, 0xfffb],
]

function isUnsafe(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

export function cleanLabel(raw: unknown, max: number): string {
  if (typeof raw !== "string") return ""
  const spaced = Array.from(raw, ch => (isUnsafe(ch.codePointAt(0) ?? 0) ? " " : ch)).join("")
  const flat = spaced.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : chars.slice(0, max).join("").trim()
}
