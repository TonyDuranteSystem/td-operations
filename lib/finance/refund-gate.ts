/**
 * The refund/dispute gate a path that links a Stripe charge to invoices must pass first.
 *
 * A refunded or disputed card payment is not our money any more, and linking it to invoices —
 * even for the record — would leave the books saying the client paid. The single-invoice match
 * (`manualMatch`) has always asked Stripe live; this is the same question as a helper, so the
 * several-invoices link asks it too. Not a Stripe payment, or no charge id → nothing to check.
 */
export async function stripeRefundGate(
  feed: { source?: string | null; external_id?: string | null } | null | undefined,
): Promise<{ error?: string }> {
  if (feed?.source !== "stripe" || !feed.external_id) return {}
  const { isChargeRefundedNow } = await import("@/lib/stripe-sync")
  const check = await isChargeRefundedNow(String(feed.external_id))
  if (check === "refunded") {
    return { error: "This Stripe payment has been refunded or disputed — the money is no longer ours, so it was NOT linked to any invoice." }
  }
  if (check === "defer") {
    return { error: "Could not verify this payment with Stripe right now — try again in a moment." }
  }
  return {}
}
