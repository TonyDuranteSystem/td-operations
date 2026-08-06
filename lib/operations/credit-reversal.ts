/**
 * Money going BACK: a refunded or disputed charge (WS-A, dev job c0a61e44).
 *
 * Two cases, deliberately different:
 *  - the credit is UNSPENT → void it (cancel the credit note, zero its balance).
 *    Nothing else in the books moves; the client simply no longer holds credit
 *    they were refunded.
 *  - the credit is SPENT → we CANNOT un-spend it: the service invoice it
 *    reduced is a signed commercial fact. A review card is raised carrying the
 *    true-up recipe, because the correct entries are a judgement call about a
 *    real client's balance, not something to guess automatically.
 *
 * Everything here is keyed on the charge id, so it works no matter which rail
 * (webhook now, or a later reconciliation) reports the reversal.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { paidCallIdempotencyKey } from "@/lib/calendly/paid-booking"

export type ReversalOutcome =
  | { outcome: "no_credit_found"; chargeId: string }
  | { outcome: "voided"; chargeId: string; creditId: string; amount: number }
  | { outcome: "needs_review"; chargeId: string; creditId: string; reason: string }

export async function handleChargeReversal(
  chargeId: string,
  eventType: string,
): Promise<ReversalOutcome> {
  const key = paidCallIdempotencyKey(chargeId, "credit")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credit_consumed_by is newer than the generated types (same pattern as the claim writes)
  const db = supabaseAdmin as unknown as { from: (t: string) => any }
  const { data: credit } = await db
    .from("payments")
    .select("id, credit_remaining, total, invoice_status, status, credit_consumed_by")
    .eq("idempotency_key", key)
    .maybeSingle()

  if (!credit) {
    // Not one of ours (an ordinary client refund) — the existing settlement-time
    // refund gate already covers those; nothing to do here.
    console.warn(`[credit-reversal] ${eventType}: no paid-call credit for charge ${chargeId}`)
    return { outcome: "no_credit_found", chargeId }
  }

  const row = credit as unknown as {
    id: string
    credit_remaining: number | null
    total: number | null
    invoice_status: string | null
    credit_consumed_by: string | null
  }
  const remaining = Number(row.credit_remaining ?? 0)
  const spent = !!row.credit_consumed_by || remaining <= 0

  if (spent) {
    const reason =
      `Paid-call charge ${chargeId} was ${eventType === "charge.dispute.created" ? "disputed" : "refunded"}, ` +
      `but its credit was already applied to an invoice. TRUE-UP: reverse the paid-call invoice ` +
      `(the money went back), then raise the shortfall on the service invoice the credit reduced — ` +
      `the client owes that amount again. Do NOT un-spend the credit: the invoice it reduced is a signed fact.`
    try {
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({
        source: "server",
        route: "/api/webhooks/stripe",
        message: reason,
        context: { charge_id: chargeId, credit_id: row.id, event_type: eventType },
      })
    } catch (err) {
      console.error("[credit-reversal] review card failed:", err)
    }
    console.error(`[credit-reversal] SPENT credit reversed — needs human true-up: ${reason}`)
    return { outcome: "needs_review", chargeId, creditId: row.id, reason }
  }

  const { error } = await db
    .from("payments")
    .update({
      credit_remaining: 0,
      invoice_status: "Cancelled",
      status: "Cancelled",
      notes: `Voided: charge ${chargeId} ${eventType === "charge.dispute.created" ? "disputed" : "refunded"}.`,
    })
    .eq("id", row.id)
    // Only void while still unspent — a concurrent signing may have claimed it.
    .is("credit_consumed_by", null)

  if (error) {
    console.error(`[credit-reversal] void failed for credit ${row.id}:`, error.message)
    return { outcome: "needs_review", chargeId, creditId: row.id, reason: `Void failed: ${error.message}` }
  }

  console.warn(`[credit-reversal] voided unspent paid-call credit ${row.id} (charge ${chargeId})`)
  return { outcome: "voided", chargeId, creditId: row.id, amount: remaining }
}
