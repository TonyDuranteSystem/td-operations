/**
 * AI Polish's target-language decision — extracted so the rule can be pinned by a
 * test independent of the route's DB/AI-provider dependencies (dev job 9c251e65).
 */

/** Normalizes the free-text `contacts.language` field to the two we detect for. */
export function normalizePolishClientLanguage(clientLanguage: string | null | undefined): string | null {
  if (clientLanguage === 'it' || clientLanguage === 'Italian') return 'Italian'
  if (clientLanguage === 'en' || clientLanguage === 'English') return 'English'
  return clientLanguage || null
}

/**
 * What language AI Polish should write in — null means "keep the draft's own
 * language," matching the prompt's existing null-language branch.
 *
 * `preserveLanguage === true` is an explicit staff opt-out for one message; it
 * always wins, regardless of what's on file for the client.
 */
export function resolvePolishTargetLanguage(
  clientLanguage: string | null | undefined,
  preserveLanguage: boolean,
): string | null {
  if (preserveLanguage) return null
  return normalizePolishClientLanguage(clientLanguage)
}
