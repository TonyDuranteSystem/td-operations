/**
 * Referral facts read straight from the SIGNED OFFER (dev job bea928e0) — pure helpers, no database.
 *
 * Why the offer: the signing invoice never carries a referral note, and the old "setup fee" invoice code is set on
 * almost nothing. The offer is where staff record the referrer, and it is exactly what the referrer's credit note is
 * computed from at first payment, so the tag shown to staff can never disagree with the credit.
 *
 * STAFF ONLY: nothing here is used by the client portal, the invoice PDF, the emails or the client's offer view.
 */

/** Offer statuses that mean "the client signed" (process-offer-signed accepts exactly these two). */
export const SIGNED_OFFER_STATUSES = ["signed", "completed"] as const

const UUID_SUFFIX = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNING_KEY_PREFIX = "offer-signed:"

/**
 * The offer an invoice belongs to: a payment-plan part carries it directly; the signing invoice carries it in its
 * idempotency key (`offer-signed:TOKEN`, older ones `offer-signed:TOKEN:CONTACT_ID`). Null for every other invoice.
 */
export function offerTokenOfInvoice(inv: {
  idempotency_key?: string | null
  tranche_offer_token?: string | null
}): string | null {
  const direct = (inv.tranche_offer_token ?? "").trim()
  if (direct) return direct
  const key = inv.idempotency_key ?? ""
  if (!key.startsWith(SIGNING_KEY_PREFIX)) return null
  const token = key.slice(SIGNING_KEY_PREFIX.length).replace(UUID_SUFFIX, "").trim()
  return token || null
}

export interface OfferReferrerFields {
  referrer_name?: string | null
  referrer_account_id?: string | null
  referrer_contact_id?: string | null
}

/**
 * Null = this offer has no referrer. Otherwise the referrer's name as typed on the offer; an empty string means the
 * offer points at a person/company by id but carries no typed name (the caller may resolve it, or just say "Referral").
 */
export function offerReferrerName(offer: OfferReferrerFields): string | null {
  const name = (offer.referrer_name ?? "").trim()
  if (name) return name
  if (offer.referrer_account_id || offer.referrer_contact_id) return ""
  return null
}

/**
 * The setup fee shown on an offer: the first cost-summary section's total ("€3,000" → 3000). This MIRRORS the parse
 * the referrer's credit uses at first payment (lib/operations/activate-service.ts, Step 3.5) — kept as a copy on
 * purpose so the money path is untouched; tests/unit/referral-source.test.ts pins the two to the same answers.
 */
export function parseOfferSetupFee(costSummary: unknown): number {
  const first = Array.isArray(costSummary) ? (costSummary[0] as { total?: unknown } | undefined) : undefined
  const total = first?.total
  if (total === undefined || total === null || total === "") return 0
  let fee = Number(String(total).replace(/[€$,\s]/g, "")) || 0
  // Same guard as the credit path (a figure typed with the cents glued on).
  if (fee > 100000) fee = fee / 100
  return fee > 0 ? fee : 0
}

export interface SignedOfferForFee {
  created_at?: string | null
  cost_summary?: unknown
}

/**
 * A company's setup fee as its signed offer states it. When a company signed several offers the reward is on the
 * FIRST purchase, so the earliest signed offer that states a fee wins. Zero when no signed offer states one.
 */
export function setupFeeFromSignedOffers(offers: SignedOfferForFee[]): number {
  const ordered = [...offers].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
  for (const o of ordered) {
    const fee = parseOfferSetupFee(o.cost_summary)
    if (fee > 0) return fee
  }
  return 0
}
