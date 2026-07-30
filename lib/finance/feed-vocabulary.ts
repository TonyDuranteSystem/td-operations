/**
 * The bank-feed vocabulary — the ONE list of values the database will accept.
 *
 * WHY THIS FILE EXISTS (2026-07-14, the post-ship incident):
 * `td_bank_feeds` carries CHECK constraints in production listing the permitted
 * `status` and `match_confidence` values. The code wrote values that were not on
 * those lists. Every one of those writes was REJECTED by the database — and the code
 * threw the rejection away (supabase-js RETURNS errors, it does not throw), so nobody
 * ever saw it.
 *
 * The damage was not theoretical. `needs_review` is not on the production list, and the
 * matcher has been writing it for months. Result: **the review queue has never worked.**
 * Not once. Production has zero rows in `needs_review` or `activation_crashed`. Every
 * transaction the system tried to park for a human was silently rejected and left sitting
 * as `unmatched` — while the Finance UI rendered a "Needs Review" tab, a "Crashed" tab
 * and a sidebar badge, all permanently empty. Staff read empty as "nothing to review".
 *
 * A value set that lives in two places WILL drift. It did. So it lives here, once:
 *  - the code writes only these values (compile-time),
 *  - the migration generates the CHECK from these lists,
 *  - `scripts/check-db-constraints.ts` asserts the live database still agrees.
 *
 * ⚠️ Adding a value here is not enough. It must ALSO be added to the database CHECK
 * (via a migration) before any code writes it — or that write will be silently rejected,
 * exactly as before.
 */

/** Every value `td_bank_feeds.status` may hold. */
export const FEED_STATUSES = [
  "unmatched",
  "matched",
  "ignored",
  "duplicate",
  "outgoing",
  /** Parked for a human. Was NOT in the production CHECK until 2026-07-14 — this is the
   *  value whose rejection silently disabled the entire review queue. */
  "needs_review",
  /** The invoice was paid but the client's activation failed; parked with a Retry button.
   *  Also absent from the production CHECK until 2026-07-14. */
  "activation_crashed",
  /** NOT a client invoice payment — TD's own money (a Stripe payout, a bank reward, money
   *  TD spent). It has been copied into My Finances, where the company's accounting is done.
   *  Finance keeps ONLY client invoice payments, so staff working invoices never see the
   *  owner's business activity. The money is not hidden: it is visible in My Finances, which
   *  is its home — that is what makes removing it from the Bank Feed safe rather than a
   *  repeat of the invisible-`duplicate` incident. Added 2026-07-27
   *  (migration 20260727-1200-bank-feed-owner-ledger-status.sql). */
  "owner_ledger",
] as const

export type FeedStatus = (typeof FEED_STATUSES)[number]

/**
 * Every value `td_bank_feeds.match_confidence` may hold.
 *
 * ⚠️ `retroactive` IS LOAD-BEARING, NOT A LABEL. The retroactive pass builds its
 * "this invoice is already audit-linked to some feed" set by querying for it. That set is
 * the 1-invoice-many-feeds guard. Any new audit-link value invented here would be
 * INVISIBLE to that guard, letting a second feed re-link to an invoice a first feed
 * already claimed. That is why the audit-link kinds (payment-intent vs fuzzy vs manual)
 * are recorded in `review_metadata.link_kind` and NOT as new confidence values.
 *
 * ⚠️ `diagnostic` is deliberately ABSENT. Two CRM diagnose routes used to write it, in an
 * unbounded fuzzy-name bulk update that stamped one payment id onto every matched feed
 * whose sender name contained the company string. It never landed a single row, because
 * this CHECK rejected it — the constraint was accidentally shielding us from a mass
 * mis-attribution of payments. The write is deleted. Do NOT add the value back.
 */
export const MATCH_CONFIDENCES = [
  "exact",
  "high",
  "medium",
  "low",
  "manual",
  "partial",
  "retroactive",
] as const

export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number]

/** Every value `td_bank_feeds.source` may hold. */
export const FEED_SOURCES = [
  "relay",
  "mercury",
  "mercury_api",
  "banking_circle",
  "qb_deposit",
  "airwallex_email",
  "airwallex_api",
  "manual",
  "stripe",
  "chase",
  /** Revolut Business, connected via Plaid 2026-07-27. Without this entry `toFeedSource`
   *  falls back to "manual" and every Revolut transaction is permanently mislabeled
   *  (the sync upserts with ignoreDuplicates, so a later fix does not relabel old rows).
   *  Migration 20260728-0100 adds it to the database CHECK — prod DDL BEFORE this deploys. */
  "revolut",
] as const

export type FeedSource = (typeof FEED_SOURCES)[number]

/**
 * Turn a bank's display name into a permitted `source` value.
 *
 * ⚠️ A DERIVED VALUE IN A CONSTRAINED COLUMN IS INVISIBLE TO EVERY GUARD WE HAVE.
 * The Plaid sync used to write `bankName.toLowerCase().replace(/\s+/g, '_')` straight into
 * `source`. Because it is computed at runtime rather than written as a literal, TypeScript
 * cannot type it and `scripts/check-db-constraints.ts` cannot see it. Link a Plaid
 * institution whose display name is not one of the ten permitted values — "Bank of America"
 * becomes `bank_of_america` — and the database rejects EVERY transaction from that bank.
 * Same class of failure as the one that silently disabled the review queue, in a shape the
 * contract check is structurally blind to.
 *
 * So: map it, and fall back to a value the database will definitely accept rather than
 * inventing one it will definitely reject. An unrecognised bank is a data-quality problem;
 * a rejected transaction is lost money.
 */
export function toFeedSource(bankName: string): FeedSource {
  const normalized = bankName.toLowerCase().trim().replace(/\s+/g, "_")

  if ((FEED_SOURCES as readonly string[]).includes(normalized)) {
    return normalized as FeedSource
  }

  console.warn(
    `[feed-vocabulary] Bank "${bankName}" is not a known feed source (normalized: "${normalized}"). ` +
    `Falling back to "manual" so its transactions are still recorded. ` +
    `To give this bank its own source, add it to FEED_SOURCES *and* to the database CHECK constraint — in that order.`,
  )
  return "manual"
}

/**
 * How a feed came to be linked to an invoice, when NO money moved.
 *
 * Recorded in `review_metadata`, not in `match_confidence` — see the warning above.
 * `payment_intent` is the certain link (Stripe's own id); `fuzzy` is the name/amount
 * retroactive guess; `manual` is a human's decision.
 */
export type AuditLinkKind = "payment_intent" | "fuzzy" | "manual"

/** The `review_metadata` shape written whenever a feed is linked but no money moved. */
export interface AuditLinkMetadata {
  audit_link: true
  link_kind: AuditLinkKind
  money_applied: false
  note: string
}

export function auditLinkMetadata(kind: AuditLinkKind, note: string): AuditLinkMetadata {
  return { audit_link: true, link_kind: kind, money_applied: false, note }
}

// ────────────────────────────────────────────────────────────────────────────────────────
// review_metadata keys, and the pure readers/writers for the two the MATCHER OBEYS.
//
// These are namespaced top-level keys so `updateFeed`'s shallow merge keeps them independent
// of each other (and of the multi-match allocation record, and of the refund flag).
// ────────────────────────────────────────────────────────────────────────────────────────

/** One candidate in a contested park — enough for a human to choose without a lookup. */
export interface ContestedCandidate {
  payment_id: string
  invoice_number: string | null
  client_name: string | null
  score: number
  confidence: string
}

export interface ContestedMetadata {
  /** Why this row is parked: several candidates were equally good. */
  reason: "tied_candidates"
  at: string
  candidates: ContestedCandidate[]
  /** How many tied in total — `candidates` may be a capped sample of this. */
  total: number
}

/**
 * How many tied candidates are recorded and shown.
 *
 * ⛔ WHY THERE IS A CAP (found 2026-07-29 by running the E2E harness against a full dataset,
 * not by reasoning). On a real book of invoices an amount-only tie is not a pair — a $1,000
 * wire with no name evidence and no invoice number ties with EVERY open $1,000 invoice, which
 * was dozens of rows. Unbounded, that writes a huge blob into the transaction and renders a
 * wall of invoices in the review banner: unreadable on a laptop, useless on a phone, and
 * exactly the kind of screen people learn to skip. The count is kept in full so the message
 * can say how many there really are — the honest summary, not a silent truncation.
 */
export const CONTESTED_SAMPLE_LIMIT = 6

export function contestedMetadata(
  candidates: ContestedCandidate[],
  at: string,
): { contested: ContestedMetadata } {
  return {
    contested: {
      reason: "tied_candidates",
      at,
      candidates: candidates.slice(0, CONTESTED_SAMPLE_LIMIT),
      total: candidates.length,
    },
  }
}

/** The true number of tied candidates, even when only a sample was recorded. */
export function readContestedTotal(reviewMetadata: unknown): number {
  if (!reviewMetadata || typeof reviewMetadata !== "object" || Array.isArray(reviewMetadata)) return 0
  const contested = (reviewMetadata as Record<string, unknown>).contested
  if (!contested || typeof contested !== "object" || Array.isArray(contested)) return 0
  const total = (contested as Record<string, unknown>).total
  if (typeof total === "number" && Number.isFinite(total)) return total
  // Older rows written before the count existed: fall back to what was stored.
  return readContestedCandidates(reviewMetadata).length
}

/** Read the contested set back off a feed row. Returns [] when the row is not contested. */
export function readContestedCandidates(reviewMetadata: unknown): ContestedCandidate[] {
  if (!reviewMetadata || typeof reviewMetadata !== "object" || Array.isArray(reviewMetadata)) return []
  const contested = (reviewMetadata as Record<string, unknown>).contested
  if (!contested || typeof contested !== "object" || Array.isArray(contested)) return []
  const list = (contested as Record<string, unknown>).candidates
  if (!Array.isArray(list)) return []
  return list.filter(
    (c): c is ContestedCandidate =>
      !!c && typeof c === "object" && typeof (c as ContestedCandidate).payment_id === "string",
  )
}

/**
 * A (transaction → invoice) pair a HUMAN has explicitly rejected.
 *
 * ⛔ THE AUTO-MATCHER MUST OBEY THIS. Load-bearing, not audit decoration:
 * un-matching returns the transaction to `unmatched`, and the sync re-runs every 15 minutes,
 * so without this memory the matcher re-proposes — and can re-apply — the exact pair a human
 * just undid. That is the wrong-client re-credit, on a timer.
 *
 * A human may still match a rejected pair BY HAND (that is them changing their mind, with the
 * evidence in front of them). Only the automatic path is bound.
 */
export interface RejectedPair {
  payment_id: string
  at: string
  by: string | null
}

/** Append a rejection, replacing any earlier entry for the same invoice. Pure. */
export function appendRejectedPair(
  reviewMetadata: unknown,
  pair: RejectedPair,
): { rejected_pairs: RejectedPair[] } {
  const existing = readRejectedPairs(reviewMetadata).filter(
    (p) => p.payment_id !== pair.payment_id,
  )
  return { rejected_pairs: [...existing, pair] }
}

export function readRejectedPairs(reviewMetadata: unknown): RejectedPair[] {
  if (!reviewMetadata || typeof reviewMetadata !== "object" || Array.isArray(reviewMetadata)) return []
  const list = (reviewMetadata as Record<string, unknown>).rejected_pairs
  if (!Array.isArray(list)) return []
  return list.filter(
    (p): p is RejectedPair =>
      !!p && typeof p === "object" && typeof (p as RejectedPair).payment_id === "string",
  )
}

/** Is this (transaction, invoice) pair one a human already rejected? */
export function isRejectedPair(reviewMetadata: unknown, paymentId: string): boolean {
  return readRejectedPairs(reviewMetadata).some((p) => p.payment_id === paymentId)
}
