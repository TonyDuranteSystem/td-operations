/**
 * Calendly PAID-booking detection + the credit it creates (WS-A, dev job c0a61e44).
 *
 * Pure decision layer: the webhook fetches/writes, THIS decides. Detection is
 * structural — a payment object that is present, non-null and successful —
 * never an event-type name and never an amount (locked: amounts and currencies
 * vary; €257 and $157 are both real, verified in production).
 *
 * Shape verified against a REAL production delivery (Aug-5 booking):
 *   payload.payload.payment = {
 *     amount: 257, currency: "EUR", provider: "stripe",
 *     successful: true, external_id: "ch_…", terms: ""
 *   }
 * Free bookings carry the SAME key with a JSON null value — so presence alone
 * is not the test (verified: 12/12 recent rows carry the key; 10 are null).
 */

export interface CalendlyPayment {
  amount: number
  currency: "EUR" | "USD"
  /** The Stripe CHARGE id (ch_…). Resolved to a PaymentIntent before stamping. */
  chargeId: string
  provider: string
}

/** Extract a SUCCESSFUL paid-booking payment, or null for free/failed bookings. */
export function extractPaidBooking(payload: unknown): CalendlyPayment | null {
  const p = (payload as { payload?: Record<string, unknown> })?.payload
  if (!p || typeof p !== "object") return null
  const pay = (p as { payment?: unknown }).payment
  // Present-but-null is the FREE-booking shape — not a paid call.
  if (!pay || typeof pay !== "object") return null

  const raw = pay as Record<string, unknown>
  if (raw.successful !== true) return null

  const amount = Number(raw.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null

  const currencyRaw = String(raw.currency || "").toUpperCase()
  if (currencyRaw !== "EUR" && currencyRaw !== "USD") return null

  const chargeId = String(raw.external_id || "")
  if (!chargeId) return null

  return {
    amount,
    currency: currencyRaw,
    chargeId,
    provider: String(raw.provider || "stripe"),
  }
}

/**
 * The idempotency key for BOTH rows a paid booking creates (the Paid invoice and
 * the credit note). Keyed on the charge — a webhook re-delivery, or a reschedule
 * that repeats the original payment, can never mint a second credit.
 */
export function paidCallIdempotencyKey(chargeId: string, kind: "invoice" | "credit"): string {
  return `calendly-call:${chargeId}:${kind}`
}

/** Client-facing description for the paid-call invoice + credit note. */
export function paidCallDescription(date: string | null): string {
  return date ? `Paid Strategy Call — ${date}` : "Paid Strategy Call"
}
