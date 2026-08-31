/**
 * Card-autopay Stripe setup-session completion — extracted out of
 * app/api/webhooks/stripe/route.ts (2026-08-31, council review) so it can be
 * unit-tested directly. A Next.js route.ts file may only export the HTTP
 * method handlers (GET/POST/...) — anything else it exports is silently
 * dropped at build time (not caught by tsc), so this logic could not be
 * imported into a test from inside the route at all.
 *
 * Also fixes a real blocker found in that review: Stripe redelivers a
 * webhook event on any non-2xx response (including a transient cold-start
 * timeout). With no dedup, a redelivery of an ALREADY-PROCESSED setup
 * completion would unconditionally re-enable autopay — silently reversing a
 * disable a staff member or the client made in between the two deliveries,
 * using a payment method that may already be detached. Dedup is keyed on
 * the Checkout Session id: a completed session is a one-time event, so
 * seeing the same id twice always means a redelivery, never a second
 * legitimate enrollment (that would be a NEW session id).
 */
import StripeConstructor from "stripe"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveAutopayCard } from "@/lib/operations/card-autopay"
import type { Json } from "@/lib/database.types"

type StripeClient = ReturnType<typeof StripeConstructor>

export interface StripeSetupSession {
  id: string
  mode?: string
  setup_intent: string | null
  customer: string | null
  metadata: Record<string, string> | null
}

let _stripe: StripeClient | null = null
function getStripeSdk(): StripeClient | null {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    try {
      _stripe = StripeConstructor(key)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _stripe = new (StripeConstructor as any)(key)
    }
  }
  return _stripe
}

export async function handleAutopaySetupCompleted(session: StripeSetupSession): Promise<void> {
  const accountId = session.metadata?.account_id || null
  if (!accountId) {
    console.error(`[stripe-webhook] autopay setup session ${session.id} missing account_id metadata`)
    return
  }
  if (!session.setup_intent || !session.customer) {
    console.error(`[stripe-webhook] autopay setup session ${session.id} missing setup_intent/customer`)
    return
  }

  const { data: alreadyProcessed } = await supabaseAdmin
    .from("webhook_events")
    .select("id")
    .eq("source", "stripe")
    .eq("event_type", "autopay_setup_completed")
    .eq("external_id", session.id)
    .maybeSingle()
  if (alreadyProcessed) {
    console.warn(`[stripe-webhook] autopay setup session ${session.id} already processed — skipping redelivery`)
    return
  }

  const stripe = getStripeSdk()
  if (!stripe) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY not set — cannot finish autopay enrollment")
    return
  }

  try {
    const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent)
    const paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id

    if (!paymentMethodId) {
      console.error(`[stripe-webhook] setup_intent ${session.setup_intent} has no payment_method`)
      return
    }

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    const last4 = pm.card?.last4 || null

    await saveAutopayCard({
      accountId,
      stripeCustomerId: session.customer,
      paymentMethodId,
      last4,
    })

    // Marked AFTER saveAutopayCard succeeds — if the process dies mid-way, a
    // genuine redelivery should still be free to retry, not be dedup'd away
    // by a marker for work that never actually completed.
    await supabaseAdmin.from("webhook_events").insert({
      source: "stripe",
      event_type: "autopay_setup_completed",
      external_id: session.id,
      payload: session as unknown as Json,
    })

    console.warn(`[stripe-webhook] card autopay enrolled for account ${accountId} — card ending ${last4}`)
  } catch (err) {
    console.error(`[stripe-webhook] autopay setup completion failed for session ${session.id}:`, err)
  }
}
