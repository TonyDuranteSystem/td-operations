/**
 * Shared atomic claim for the two payment-charging paths that can act on the
 * same `payments` row: the client's own "Pay Invoice" checkout-session
 * creation (app/api/workflows/create-invoice-checkout/route.ts) and the
 * unattended card-autopay cron. Whichever caller wins `charge_claimed_until`
 * may create a Stripe object for this payment; the other must not.
 *
 * The claim intentionally re-checks status != 'Paid' in the SAME UPDATE
 * statement — checking status separately first and claiming second would
 * leave a gap where the payment is marked Paid by a webhook in between.
 *
 * A claim is short-lived on purpose: it only needs to cover "create one
 * Stripe object," not the lifetime of a Stripe Checkout Session. The cron
 * closes that longer-lived gap itself by actively expiring any live
 * Checkout Session (via payments.stripe_checkout_session_id) before it
 * charges — see app/api/cron/card-autopay-charge/route.ts.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const CLIENT_CLAIM_TTL_MS = 2 * 60 * 1000
export const CRON_CLAIM_TTL_MS = 5 * 60 * 1000

export async function claimPaymentForCharge(
  paymentId: string,
  ttlMs: number
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const claimedUntil = new Date(Date.now() + ttlMs).toISOString()

  const { data, error } = await supabaseAdmin
    .from("payments")
    .update({ charge_claimed_until: claimedUntil } as never)
    .eq("id", paymentId)
    .neq("status", "Paid")
    .or(`charge_claimed_until.is.null,charge_claimed_until.lt.${nowIso}`)
    .select("id")

  if (error) {
    console.error(`[autopay-claim] claim failed for payment ${paymentId}:`, error.message)
    return false
  }

  return Boolean(data && data.length > 0)
}

export async function releasePaymentClaim(paymentId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payments")
    .update({ charge_claimed_until: null } as never)
    .eq("id", paymentId)

  if (error) {
    console.error(`[autopay-claim] release failed for payment ${paymentId}:`, error.message)
  }
}

/**
 * Records the Checkout Session the client just opened for this invoice, so
 * the card-autopay cron can look it up and actively expire it before it
 * charges off-session (a Stripe Checkout Session can't be told to expire in
 * under 30 minutes on its own, so this is the only way to close that gap).
 */
export async function recordCheckoutSessionId(paymentId: string, sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payments")
    .update({ stripe_checkout_session_id: sessionId } as never)
    .eq("id", paymentId)

  if (error) {
    console.error(`[autopay-claim] recordCheckoutSessionId failed for payment ${paymentId}:`, error.message)
  }
}
