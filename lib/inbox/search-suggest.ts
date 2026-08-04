/**
 * Type-ahead search suggestions for the Inbox search box.
 *
 * WHY THIS EXISTS: the inbox search only ran on Enter and matched WHOLE WORDS —
 * typing "anto" returned nothing at all until you finished "antonio" (verified
 * on production 2026-08-04: 'anto' → 0 rows, 'antonio' → 2,473). A dropdown on
 * top of that would sit empty while you type, so prefix matching is not a
 * nicety here, it is the thing that makes a dropdown possible.
 */

/** The most a suggestion dropdown should ever show. */
export const SUGGEST_LIMIT = 8

/** Below this, every query matches half the mailbox — not worth a round trip. */
export const SUGGEST_MIN_CHARS = 2

/**
 * Turn what the user has typed into a Postgres tsquery, Gmail-style:
 * every completed word must match, and the LAST word — the one still under
 * the cursor — matches as a prefix.
 *
 * Returns null when there is nothing searchable, which the caller treats as
 * "show no dropdown" rather than "search for everything".
 *
 * Tokens are stripped to letters and digits. That is the injection boundary:
 * the result is interpolated into `to_tsquery()`, which raises on malformed
 * syntax, so an unsanitised apostrophe or `&` would turn a search into an
 * error. Accented letters are kept — the index is built with the 'simple'
 * config, which does not fold them, so stripping them would break real names.
 */
export function buildPrefixTsQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    // Strip ASCII punctuation and symbols only. A `\p{L}` class would need a
    // newer compile target, and an allow-list of A-Z0-9 would eat the accents
    // and non-Latin scripts real names are written in.
    .map((t) => t.replace(/[\s!-/:-@[-`{-~]/g, ""))
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null

  const last = tokens[tokens.length - 1]
  const head = tokens.slice(0, -1)
  // Only the last token gets `:*`. Prefixing the completed words too would make
  // "to ross" match every word starting with "to" — noise the user already
  // told us they were done typing.
  return [...head, `${last}:*`].join(" & ")
}

/**
 * Should the dropdown fire for what is in the box?
 *
 * Operator searches (from:, has:attachment, …) are deliberately EXCLUDED: those
 * are answered by live Gmail, which is seconds slow, and they keep the existing
 * press-Enter path. The dropdown is only ever backed by our own index.
 */
export function shouldSuggest(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false
  const trimmed = raw.trim()
  if (trimmed.length < SUGGEST_MIN_CHARS) return false
  if (/\b\w+:/.test(trimmed)) return false // an operator query — not ours
  return buildPrefixTsQuery(trimmed) !== null
}
