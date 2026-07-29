/**
 * Choosing between candidate invoices for one incoming payment — and REFUSING to choose
 * when the evidence cannot tell them apart.
 *
 * ⛔ THE INCIDENT (2026-07-22, production, $1,000).
 * A wire from "LC Marketing Consulting" produced TWO candidates with the SAME top score:
 * Aces Marketing Solutions' open $1,000 invoice and LC Marketing Consulting's open $1,000
 * invoice. The matcher did `candidates.sort((a,b) => b.score - a.score)` and took `[0]`.
 * With equal scores that comparator preserves input order, and the input order came from a
 * database query with NO `ORDER BY` — so **which client got credited $1,000 was decided by
 * physical row order**. The wrong one won, the invoice was marked Paid, the client's
 * tax-return payment gate was lifted and an internal "ready for accountant" email went out,
 * all with no human involved.
 *
 * TWO THINGS THIS MODULE FIXES:
 *   1. **A tie is never settled automatically.** If more than one candidate holds the top
 *      score, nothing is applied — the transaction is parked for a human WITH the tied set
 *      recorded, so they can see what the machine could not decide.
 *   2. **The ordering is deterministic.** Even outside a tie, the winner no longer depends on
 *      row order. That matters for tests (a fixture can assert the guard rather than getting
 *      lucky) and for support ("why did it pick that one" now has an answer).
 *
 * SAME-CLIENT TIES COUNT TOO. A client holding two invoices of the same price is exactly as
 * undecidable — only the invoice number can separate them, and that is what the reference
 * tier is for. This is the documented behaviour of the payer-identity tier already; it was
 * simply absent from the fuzzy path.
 *
 * THE ONE EXEMPTION — duplicate rows for ONE obligation. Production contains cases where a
 * single obligation exists as two `payments` rows (one real invoice plus an orphan row left by
 * an older webhook path). Those tie forever, and no human answer is "correct", so the guard
 * would deadlock the client's payment. When every tied row belongs to the SAME client and
 * exactly one of them carries an invoice number, that row wins — the same rule the Stripe
 * payment-intent tier already uses to break its own ambiguity.
 */

export interface ScoredCandidate {
  id: string
  invoiceNumber: string | null
  confidence: "exact" | "high" | "medium"
  score: number
  /** Who the invoice belongs to — used only to tell a duplicate-row tie (same client) from a
   *  two-different-clients tie (never auto-settled). */
  accountId?: string | null
  contactId?: string | null
  /** Display name for the contested record a human reads. */
  clientName?: string | null
}

export interface CandidateSelection {
  /** The winner, or null when there were no candidates at all. */
  best: ScoredCandidate | null
  /** True ⇒ do NOT auto-settle. Park for review and record `tied`. */
  contested: boolean
  /** The full top-score group when contested; empty otherwise. */
  tied: ScoredCandidate[]
  /** Why it is contested — for the record a human reads. */
  reason?: "tied_across_clients" | "tied_same_client"
}

/** Stable identity of the client an invoice belongs to (account first, else the contact). */
function clientKey(c: ScoredCandidate): string {
  return c.accountId ? `a:${c.accountId}` : c.contactId ? `c:${c.contactId}` : `i:${c.id}`
}

/**
 * Deterministic ordering: best score first; within equal scores, a row carrying an invoice
 * number outranks one without (the orphan-row case); then by id so the result never depends
 * on the order the database happened to return.
 */
export function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score
  const aHasNumber = a.invoiceNumber ? 1 : 0
  const bHasNumber = b.invoiceNumber ? 1 : 0
  if (bHasNumber !== aHasNumber) return bHasNumber - aHasNumber
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function selectBestCandidate(candidates: ScoredCandidate[]): CandidateSelection {
  if (candidates.length === 0) return { best: null, contested: false, tied: [] }

  const ordered = [...candidates].sort(compareCandidates)
  const best = ordered[0]
  const topGroup = ordered.filter((c) => c.score === best.score)

  if (topGroup.length === 1) return { best, contested: false, tied: [] }

  // Duplicate rows for one obligation: same client, exactly one numbered row → that row wins.
  const clients = new Set(topGroup.map(clientKey))
  if (clients.size === 1) {
    const numbered = topGroup.filter((c) => !!c.invoiceNumber)
    if (numbered.length === 1) {
      return { best: numbered[0], contested: false, tied: [] }
    }
    return { best, contested: true, tied: topGroup, reason: "tied_same_client" }
  }

  return { best, contested: true, tied: topGroup, reason: "tied_across_clients" }
}
