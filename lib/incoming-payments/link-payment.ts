/**
 * A payment made through a paid-call link created from the CRM lead page (`payment_kind: paid_call`, payment-link.ts).
 * The link itself says what it is, so no confirmation is needed: the Stripe webhook records it right away through the SAME core
 * as the Calendar's confirm step (`settlePayment`) — a Paid "Strategic Call" invoice + a deductible credit; the lead is never converted.
 * Idempotent (keyed on the session), so Stripe's redelivery after a failed attempt records it exactly once. THROWS on failure so the
 * webhook answers 500 and Stripe sends the event again: the payment must never be only in the raw event log.
 */

import { settlePayment, UUID_RE } from "@/lib/incoming-payments/confirm"
import type { WaitingPayment } from "@/lib/incoming-payments/classify"

interface PaidCallSession {
  id: string
  payment_intent: string | null
  amount_total: number | null
  currency: string | null
  customer_details: { email: string | null; name: string | null } | null
  metadata: Record<string, string> | null
}

export async function recordPaidCallFromSession(session: PaidCallSession, now: Date = new Date()): Promise<void> {
  const cents = Number(session.amount_total)
  const currency = String(session.currency ?? "").toUpperCase()
  if (!Number.isFinite(cents) || cents <= 0 || (currency !== "EUR" && currency !== "USD")) {
    throw new Error(`paid-call link payment ${session.id}: unusable amount or currency (${session.amount_total} ${session.currency})`)
  }
  const payment: WaitingPayment = {
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
    paymentLinkId: null,
    amount: Math.round(cents) / 100,
    currency,
    email: session.customer_details?.email?.trim() || session.metadata?.client_email?.trim() || null,
    name: session.customer_details?.name?.trim() || null,
    paidAt: now.toISOString(),
  }
  const ref = session.metadata?.crm_lead_ref?.trim() || ""
  const leadId = UUID_RE.test(ref) ? ref : null

  let r = await settlePayment({ payment, resolution: "paid_call", leadId, actor: "payment link (paid call)" })
  // The lead was deleted after the link was made: the money still has to be recorded, by the payer's email.
  if (!r.ok && r.status === 404 && leadId) r = await settlePayment({ payment, resolution: "paid_call", leadId: null, actor: "payment link (paid call)" })
  if (!r.ok) throw new Error(`paid-call link payment ${session.id}: ${r.error}`)
}
