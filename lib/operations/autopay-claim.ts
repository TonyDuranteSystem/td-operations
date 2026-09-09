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
/**
 * How long to HOLD (not release) a claim when Stripe has already charged the
 * card but confirmPayment's own write did not land cleanly (dev job
 * 4ca2c691, full council review 2026-09-09). Comfortably longer than the
 * 6-hourly Stripe reconciliation sync (lib/stripe-sync.ts) that eventually
 * self-heals an orphaned charge, with real margin — a human is expected to
 * resolve the staff task this raises well before the hold expires.
 */
export const AUTOPAY_HOLD_TTL_MS = 24 * 60 * 60 * 1000

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
 * Extends (rather than releases) an existing claim. Use when Stripe has
 * already charged the card but recording that charge did not land cleanly —
 * releasing here would leave BOTH the next cron run and the client's own
 * "Pay Invoice" button free to attempt a charge that already succeeded,
 * which is exactly the double-charge this whole claim mechanism exists to
 * prevent. Holding blocks both re-entry paths until a human resolves the
 * mismatch, or the row naturally falls out of candidacy on its own (the
 * Stripe reconciliation sync settling it through the normal status flip).
 */
export async function holdPaymentClaim(paymentId: string, ttlMs: number): Promise<void> {
  const claimedUntil = new Date(Date.now() + ttlMs).toISOString()
  const { error } = await supabaseAdmin
    .from("payments")
    .update({ charge_claimed_until: claimedUntil } as never)
    .eq("id", paymentId)

  if (error) {
    console.error(`[autopay-claim] hold failed for payment ${paymentId}:`, error.message)
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
