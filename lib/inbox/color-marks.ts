/**
 * Color marks for inbox emails.
 *
 * A "mark" is a Gmail label named `Marked/<Color>` applied to the whole
 * thread. Storing marks as Gmail labels (instead of a DB table) means:
 *  - the mark lives with the email and is visible in the real Gmail UI too;
 *  - it is per-mailbox, exactly like every other thread property;
 *  - the labels sidebar gives filter-by-color for free.
 *
 * One color per thread — setting a color removes any other Marked/* label.
 * `gmailColor` values come from Gmail's fixed allowed label palette; label
 * creation falls back to colorless if Gmail rejects the color.
 */

export const MARK_LABEL_PREFIX = "Marked/"

export interface ColorMark {
  key: string
  /** Human label shown in the picker */
  label: string
  /** Gmail label name */
  labelName: string
  /** Dot color in the CRM UI */
  hex: string
  /** Gmail label color (from Gmail's allowed palette) */
  gmailColor: { backgroundColor: string; textColor: string }
}

export const COLOR_MARKS: readonly ColorMark[] = [
  { key: "red",    label: "Red",    labelName: "Marked/Red",    hex: "#ef4444", gmailColor: { backgroundColor: "#fb4c2f", textColor: "#ffffff" } },
  { key: "orange", label: "Orange", labelName: "Marked/Orange", hex: "#f97316", gmailColor: { backgroundColor: "#ffad47", textColor: "#ffffff" } },
  { key: "yellow", label: "Yellow", labelName: "Marked/Yellow", hex: "#eab308", gmailColor: { backgroundColor: "#fad165", textColor: "#594c05" } },
  { key: "green",  label: "Green",  labelName: "Marked/Green",  hex: "#22c55e", gmailColor: { backgroundColor: "#16a766", textColor: "#ffffff" } },
  { key: "blue",   label: "Blue",   labelName: "Marked/Blue",   hex: "#3b82f6", gmailColor: { backgroundColor: "#4a86e8", textColor: "#ffffff" } },
  { key: "purple", label: "Purple", labelName: "Marked/Purple", hex: "#a855f7", gmailColor: { backgroundColor: "#a479e2", textColor: "#ffffff" } },
] as const

export function markByKey(key: string | null | undefined): ColorMark | null {
  if (!key) return null
  return COLOR_MARKS.find((m) => m.key === key) ?? null
}

/** Resolve the mark from a set of Gmail label NAMES (first match wins). */
export function markFromLabelNames(names: Iterable<string>): ColorMark | null {
  const set = new Set(names)
  for (const mark of COLOR_MARKS) {
    if (set.has(mark.labelName)) return mark
  }
  return null
}
