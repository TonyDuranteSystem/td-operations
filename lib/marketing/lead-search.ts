/**
 * TD Marketing — searching the team's leads (pure; dev job 9aec66fa). The words typed in the search bar become a safe filter: letters, digits, and the few signs a name or a phone number
 * can hold; anything that could change the meaning of the database filter (commas, brackets, percent signs, quotes) is dropped before it gets near it.
 */
export const SEARCH_MIN = 2
export const SEARCH_MAX = 60
export const SEARCH_LIMIT = 8

/** The cleaned search text, or null when it is too short to search for. */
export function cleanSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const s = raw.normalize("NFKC").replace(/[^A-Za-z0-9\u00C0-\u024F@.+\- ]/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX)
  return s.length >= SEARCH_MIN ? s : null
}

/** The digits of a search ("+39 335 12" -> "3933512"), or null when there are fewer than 4 (then the text is not a phone number). */
export function searchDigits(clean: string): string | null {
  const d = clean.replace(/\D/g, "")
  return d.length >= 4 ? d : null
}

/** The filter for the database: name or email contains the text; phone contains the digits when the text looks like a number. */
export function searchFilter(clean: string, canSeePhone: boolean): string {
  const parts = [`full_name.ilike.%${clean}%`, `email.ilike.%${clean}%`]
  const d = searchDigits(clean)
  if (d && canSeePhone) parts.push(`phone.ilike.%${d.split("").join("%")}%`)
  return parts.join(",")
}
