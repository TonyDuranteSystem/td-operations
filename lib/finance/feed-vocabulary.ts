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
