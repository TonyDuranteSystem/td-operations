/**
 * Feed signals — the shared primitives for "who sent this money, and what for?".
 *
 * Extracted 2026-07-14 (Simple Holdings / Fazekas incident).
 *
 * SCOPE — read this before trusting the module name. The NEW identity signals
 * (payment-intent link, payer email, invoice reference) live here and ONLY here, so
 * they cannot drift. The OLD name-fuzzing logic is NOT yet consolidated: the matcher
 * (`lib/bank-feed-matcher.ts`), the audit cascade (`lib/audit/bank-feed-cascade.ts`)
 * and the Finance UI's client-side scorer still each carry their own stop-word list
 * and their own feed-text builder. Folding those three into this module is deliberately
 * deferred work — do not assume it has happened.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/** A bank-feed row, as far as identity resolution is concerned. */
export interface FeedSignalSource {
  source?: string | null
  sender_name?: string | null
  memo?: string | null
  sender_reference?: string | null
  raw_data?: unknown
}

/**
 * Every email address we can find on a feed — from the memo text and from the
 * Stripe charge payload (billing_details.email / receipt_email / metadata.email).
 *
 * This is the STRONGEST identity signal available on a card payment: the cardholder
 * name is unreliable, but the billing email reliably resolves to a CRM contact and,
 * through account_contacts, to the company being paid for.
 */
export function extractFeedEmails(feed: FeedSignalSource): string[] {
  const out = new Set<string>()
  const text = `${feed.sender_name ?? ""} ${feed.memo ?? ""} ${feed.sender_reference ?? ""}`
  for (const m of text.match(EMAIL_RE) ?? []) out.add(m.toLowerCase())

  if (feed.raw_data && typeof feed.raw_data === "object") {
    const rd = feed.raw_data as {
      metadata?: { email?: unknown; client_email?: unknown }
      billing_details?: { email?: unknown }
      receipt_email?: unknown
    }
    const candidates = [
      rd.metadata?.email,
      rd.metadata?.client_email,
      rd.billing_details?.email,
      rd.receipt_email,
    ]
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) out.add(c.trim().toLowerCase())
    }
  }
  return Array.from(out)
}

/**
 * The Stripe PaymentIntent id on a stored charge (`raw_data.payment_intent`).
 *
 * This is the CERTAIN link: when our Stripe webhook marks an invoice paid it stores
 * that same PaymentIntent id on the invoice. Comparing the two ties a bank-feed row
 * to its invoice with no guessing at all — and it works retroactively on charges
 * already in the table. Nothing compared them before 2026-07-14, which is why every
 * Stripe-paid invoice left a permanently unmatched feed row behind.
 */
export function extractStripePaymentIntent(feed: FeedSignalSource): string | null {
  if (feed.source !== "stripe") return null
  if (!feed.raw_data || typeof feed.raw_data !== "object") return null
  const pi = (feed.raw_data as { payment_intent?: unknown }).payment_intent
  if (typeof pi === "string" && pi.startsWith("pi_")) return pi
  // Expanded PaymentIntent object (when the sync expands it).
  if (pi && typeof pi === "object") {
    const id = (pi as { id?: unknown }).id
    if (typeof id === "string" && id.startsWith("pi_")) return id
  }
  return null
}

/**
 * The invoice number Stripe carried on the payment, if any.
 *
 * Read from the charge metadata AND from the expanded PaymentIntent's metadata —
 * Stripe does NOT copy Checkout Session metadata onto the Charge (that assumption is
 * precisely what broke reconciliation: we set the invoice number on the session, and
 * it never reached the feed). Reading the PaymentIntent removes the bet entirely.
 */
export function extractInvoiceReference(feed: FeedSignalSource): string | null {
  if (!feed.raw_data || typeof feed.raw_data !== "object") return null
  const rd = feed.raw_data as {
    metadata?: { invoice_number?: unknown }
    payment_intent?: { metadata?: { invoice_number?: unknown } } | string
  }

  const fromCharge = rd.metadata?.invoice_number
  if (typeof fromCharge === "string" && fromCharge.trim()) return fromCharge.trim()

  if (rd.payment_intent && typeof rd.payment_intent === "object") {
    const fromPi = rd.payment_intent.metadata?.invoice_number
    if (typeof fromPi === "string" && fromPi.trim()) return fromPi.trim()
  }
  return null
}

/**
 * Feed TYPE classification — "what kind of money is this?", from STRUCTURED provider
 * data, not the description wording (Antonio, 2026-07-26; Council pass #2).
 *
 * Two ideas keep this safe (both are Council blockers folded in):
 *  1. POSITIVE-EVIDENCE-ONLY. The default is `client_payment` — a row is only pulled
 *     toward a non-client type on real evidence. Nothing is classified "not a client
 *     payment" by elimination. Uncertainty stays a client payment and flows to the
 *     matcher/review, never hidden.
 *  2. TYPE is separate from BASIS (how we know). The routing layer auto-routes ONLY
 *     high-confidence bases (`structured_id`, `counterparty_exact`); `name` / `plaid_pfc`
 *     are advisory and must stay in review. Plaid's `personal_finance_category` is
 *     demonstrably wrong in BOTH directions (a client wire came back TRANSFER_IN, a
 *     Stripe payout came back INCOME), so it may only corroborate, never decide.
 *
 * This function is per-row and pure. It CANNOT confirm an internal transfer on its own
 * (that needs the two legs paired across our own accounts) nor a Stripe payout by its
 * true identity (that needs the Stripe payout-id cross-match) — those live in the
 * cross-row pass. Here it surfaces the best single-row signal with an honest basis.
 */
export type FeedType =
  | "client_payment"
  | "stripe_payout"
  | "internal_transfer"
  | "bank_reward"
  | "unknown"

/** How the type was decided, from strongest to weakest. Routing keys on this. */
export type FeedTypeBasis =
  | "structured_id" // a provider id proves it (e.g. Stripe payout id) — auto-routable
  | "counterparty_exact" // the structured counterparty IS the bank/processor — auto-routable
  | "name" // description signature only — advisory, keep in review
  | "plaid_pfc" // Plaid category corroboration only — advisory, keep in review
  | "none"

export interface FeedTypeResult {
  type: FeedType
  basis: FeedTypeBasis
  detail?: string
}

/** Bank feeds where a Stripe payout could LAND. `source='stripe'` rows are client
 * card charges (they self-identify via payment_intent) — never payouts. */
const BANK_FEED_SOURCES = new Set([
  "relay",
  "mercury",
  "mercury_api",
  "airwallex_api",
  "airwallex_email",
  "banking_circle",
  "chase",
  "qb_deposit",
])

/** "stripe" immediately followed by "transfer", separated only by space/dash/semicolon/
 * colon — a CONTIGUOUS signature. Deliberately NOT two independent contains() (which a
 * client named "…stripe…" plus a bank "wire transfer" memo would trip). The \b before
 * "stripe" also rejects "pinstripe". */
const STRIPE_PAYOUT_SIGNATURE = /\bstripe\b[\s;:–—-]+transfer\b/i

function rawObject(feed: FeedSignalSource): Record<string, unknown> {
  return feed.raw_data && typeof feed.raw_data === "object"
    ? (feed.raw_data as Record<string, unknown>)
    : {}
}

export function classifyFeedType(feed: FeedSignalSource): FeedTypeResult {
  const data = rawObject(feed)
  const source = feed.source ?? ""
  const text = `${feed.sender_name ?? ""} ${feed.memo ?? ""} ${feed.sender_reference ?? ""}`

  const counterparty =
    typeof data.counterpartyName === "string" ? data.counterpartyName.trim() : ""

  // 1. BANK REWARD — the counterparty IS the bank itself (Mercury's native feed carries a
  //    structured counterparty). EXACT match only: "Mercury Ventures LLC" (a client) must
  //    not trip it, and an empty counterparty must never match.
  if (
    (source === "mercury" || source === "mercury_api") &&
    counterparty.toLowerCase() === "mercury"
  ) {
    return { type: "bank_reward", basis: "counterparty_exact", detail: "mercury" }
  }

  // 2. STRIPE PAYOUT — only on a BANK feed (never on a client card charge, source='stripe').
  //    Robust identity (payout-id cross-match) is added with the payouts sync; until then a
  //    name signature is `basis: 'name'` so routing keeps it visible in review, not hidden.
  if (BANK_FEED_SOURCES.has(source)) {
    if (counterparty.toLowerCase() === "stripe") {
      return { type: "stripe_payout", basis: "counterparty_exact", detail: "stripe" }
    }
    if (STRIPE_PAYOUT_SIGNATURE.test(text)) {
      return { type: "stripe_payout", basis: "name" }
    }
  }

  // INTERNAL TRANSFER is deliberately NOT detected here. Plaid's ACCOUNT_TRANSFER category
  // was measured against the real feed (2026-07-26) and is WRONG most of the time: of 19
  // rows it tagged ACCOUNT_TRANSFER, only 2 were genuine own-account moves (both money going
  // OUT, already excluded by their outgoing direction); the other ~17 were real CLIENT
  // payments (WISE / Avorgate / Next To Prime / …), several already matched to invoices. And
  // every genuine internal transfer in the data goes OUT to an account we don't sync, so no
  // incoming leg exists to pair. A future internal_transfer classification must come from a
  // CONFIRMED pair-match across our OWN synced accounts (both legs present, own-account id on
  // each) — never from this per-row category, which fails toward hiding client money.

  // Default — a client payment. Stays in the matcher/review. (Positive-evidence-only.)
  return { type: "client_payment", basis: "none" }
}
