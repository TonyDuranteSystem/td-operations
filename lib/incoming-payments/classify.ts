/**
 * Incoming payments that say nothing about themselves (dev job 40a58d9a — Christian Ranieri, 2026-10-23).
 *
 * Every Stripe payment WE create carries a label in its metadata: offer and invoice payments carry `source: td-operations`
 * (plus the offer token / invoice number), marketing links carry `payment_kind`. A payment made through a link someone made
 * by hand in the Stripe Dashboard carries NOTHING. The webhook used to treat such a payment as a client service sale: it
 * flipped the lead to Converted (by email) and tried to write a payment row that fails when no contact exists.
 *
 * Rule: a payment with no label at all changes NOTHING by itself. It waits in the Calendar ("Payments to confirm") until staff
 * say what it was. PURE: shared by the webhook (to skip the client effects) and by the loader (to list what is waiting).
 */

type Meta = Record<string, string | null | undefined> | null | undefined

/** Payments before this date are never listed as waiting (older ones were settled by hand or through the bank feed). */
export const INCOMING_PAYMENTS_SINCE = "2026-10-01"

const LABEL_KEYS = ["source", "payment_kind", "offer_token", "invoice_number", "lead_id"] as const

function has(meta: Meta, key: string): boolean {
  const v = meta?.[key]
  return typeof v === "string" && v.trim() !== ""
}

/**
 * True when a completed Checkout Session carries none of the labels our own code stamps. Only one-off card payments can be
 * unlabelled-and-waiting: a setup-mode session (card on file for autopay) is never money.
 */
export function isUnlabelledPayment(session: { mode?: string | null; metadata?: Meta }): boolean {
  if (session.mode && session.mode !== "payment") return false
  return !LABEL_KEYS.some((k) => has(session.metadata, k))
}

/** What a waiting payment is, in the words the Calendar shows. Whole units (Stripe sends minor units). */
export interface WaitingPayment {
  sessionId: string
  paymentIntentId: string | null
  paymentLinkId: string | null
  amount: number
  currency: "EUR" | "USD"
  email: string | null
  name: string | null
  paidAt: string
}

interface RawEvent {
  created_at: string
  payload: Record<string, unknown> | null
}

/** One stored Stripe event -> a waiting payment, or null when it is not one (labelled, unpaid, no amount, unknown currency). */
export function waitingPaymentFromEvent(ev: RawEvent): WaitingPayment | null {
  const p = ev.payload
  if (!p || typeof p !== "object") return null
  const session = p as {
    id?: unknown; mode?: unknown; payment_status?: unknown; payment_intent?: unknown; payment_link?: unknown
    amount_total?: unknown; currency?: unknown; metadata?: Meta
    customer_details?: { email?: unknown; name?: unknown } | null
  }
  if (typeof session.id !== "string" || !session.id) return null
  if (!isUnlabelledPayment({ mode: typeof session.mode === "string" ? session.mode : null, metadata: session.metadata })) return null
  // A completed session can still be unpaid (delayed methods); only money that arrived is listed.
  if (typeof session.payment_status === "string" && session.payment_status !== "paid") return null
  const cents = Number(session.amount_total)
  if (!Number.isFinite(cents) || cents <= 0) return null
  const cur = String(session.currency ?? "").toUpperCase()
  if (cur !== "EUR" && cur !== "USD") return null
  const email = typeof session.customer_details?.email === "string" ? session.customer_details.email.trim() : ""
  const name = typeof session.customer_details?.name === "string" ? session.customer_details.name.trim() : ""
  return {
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
    paymentLinkId: typeof session.payment_link === "string" ? session.payment_link : null,
    amount: Math.round(cents) / 100,
    currency: cur,
    email: email || null,
    name: name || null,
    paidAt: ev.created_at,
  }
}

/** Keep one row per Stripe session (a redelivered event is stored twice) and drop what is already settled. Newest first. */
export function pickWaiting(
  events: RawEvent[],
  settled: { sessionIds: Set<string>; stripeIds: Set<string> },
): WaitingPayment[] {
  const seen = new Set<string>()
  const out: WaitingPayment[] = []
  for (const ev of events) {
    const w = waitingPaymentFromEvent(ev)
    if (!w || seen.has(w.sessionId)) continue
    seen.add(w.sessionId)
    if (settled.sessionIds.has(w.sessionId)) continue
    if (settled.stripeIds.has(w.sessionId) || (w.paymentIntentId && settled.stripeIds.has(w.paymentIntentId))) continue
    out.push(w)
  }
  return out.sort((a, b) => b.paidAt.localeCompare(a.paidAt))
}

/** Who in our records shares the payer's email. Suggestions only: nothing acts on them without a click. */
export interface PayerMatch {
  leads: Array<{ id: string; name: string; status: string }>
  contacts: Array<{ id: string; name: string }>
  marketingLeads: Array<{ id: string; name: string }>
}

export interface WaitingRow extends WaitingPayment {
  match: PayerMatch
}
