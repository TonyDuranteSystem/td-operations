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

/*
 * REMOVED 2026-07-27 — `classifyFeedType` and its Stripe wording signature.
 *
 * It labelled a row's type by reading the bank's description text. Antonio rejected that:
 * wording differs per bank and breaks the day payouts move accounts. The decision now lives
 * in `lib/finance/owner-ledger-projection.ts::isClientInvoicePayment`, which proves the
 * POSITIVE — a deposit stays in Finance only when something concrete says a client is paying
 * an invoice — and sends everything else to My Finances, visible and reversible.
 */
