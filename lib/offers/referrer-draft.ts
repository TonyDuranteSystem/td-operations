/**
 * Referrer box on the Create Offer window — the "typed but never picked" guard.
 *
 * The referrer search box only keeps a referrer once a result is CLICKED. Text typed into the box is just a
 * search, so an offer could be created with the referrer silently empty while the box still showed what the
 * author typed (dev job 4bc21d49: an offer for a referred lead was saved with no referrer at all).
 *
 * Pure and client-safe: the dialog passes what the picker holds and the search text currently typed.
 */

/** Fewest typed characters that count as "the author meant to search for someone" (the search itself starts at 2). */
export const REFERRER_SEARCH_MIN_CHARS = 2

export interface PickedReferrer {
  contactId: string | null
  accountId: string | null
}

/**
 * Null = fine to continue. Otherwise the plain sentence to show instead of creating the offer: the author typed a
 * name in the referrer search box but did not click anyone from the list.
 */
export function referrerDraftProblem(picked: PickedReferrer, typedSearch: string): string | null {
  const typed = typedSearch.trim()
  if (typed.length < REFERRER_SEARCH_MIN_CHARS) return null
  if (picked.contactId || picked.accountId) return null
  return `Referrer: you typed "${typed}" but did not pick anyone from the list, so the offer would have NO referrer. Click a result to select it (or clear the box), then try again.`
}

/** The one-line answer the review window shows for the referrer: who it is, or that there is none. */
export function referrerReviewLabel(referrer: { name: string; contactId: string | null; accountId: string | null }): string {
  const name = referrer.name.trim()
  if (!name) return 'None'
  if (referrer.contactId || referrer.accountId) return name
  return `${name} (typed name — not linked to a client)`
}
