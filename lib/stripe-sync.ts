/**
 * Stripe Charge Sync — Historical Reconciliation
 *
 * Fetches successful Stripe charges and upserts them into td_bank_feeds
 * for retroactive matching against client invoices.
 *
 * Uses the same Stripe SDK pattern as stripe-checkout.ts.
 * Deduplicates by external_id (charge.id) — safe to run repeatedly.
 */

import StripeConstructor from "stripe"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"

type StripeClient = ReturnType<typeof StripeConstructor>

let _stripe: StripeClient | null = null
function getStripe(): StripeClient | null {
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

interface SyncResult {
  ok: boolean
  synced: number
  skipped: number
  total: number
  error?: string
}

/**
 * The outcome of re-checking a charge with Stripe before settling money against it.
 *
 *  - "refunded"  — the money went back to the client (or is disputed). NEVER settle.
 *  - "ok"        — Stripe confirms the money is still ours. Safe to settle.
 *  - "defer"     — a TRANSIENT failure (network, Stripe down). Do not settle; try again
 *                  later. The money is already in the bank; a few hours cost nothing,
 *                  whereas booking a refunded charge costs a client relationship.
 *  - "unchecked" — we cannot ever verify this one (Stripe isn't configured, or the
 *                  charge id doesn't exist). Deferring forever would strand the feed
 *                  and help nobody, so the caller proceeds — with the same exposure it
 *                  had before this check existed, and a warning in the log.
 */
export type ChargeRefundCheck = "refunded" | "ok" | "defer" | "unchecked"

/**
 * Is this Stripe charge refunded or disputed RIGHT NOW?
 *
 * The stored charge payload is a SNAPSHOT taken at sync time. A charge refunded
 * afterwards keeps `refunded: false` frozen in our copy forever, and the sync never
 * revisits it (rows are inserted once, by transaction id). So our record can insist the
 * money is in the bank long after it went back to the client.
 *
 * That was survivable while matching needed an amount-and-name coincidence. It is not
 * survivable now: settlement can key off the charge alone (its payment intent, or the
 * invoice number it carries), deterministically. Without this check, the first cron run
 * after a refund would confidently mark an invoice paid with money the client has back.
 */
export async function isChargeRefundedNow(chargeId: string): Promise<ChargeRefundCheck> {
  const stripe = getStripe()
  if (!stripe) {
    console.warn("[stripe-sync] STRIPE_SECRET_KEY not set — cannot verify refunds; proceeding unchecked.")
    return "unchecked"
  }

  try {
    const charge = await stripe.charges.retrieve(chargeId)
    const refunded = charge.refunded === true || charge.amount_refunded > 0 || charge.disputed === true
    return refunded ? "refunded" : "ok"
  } catch (err) {
    // A charge Stripe has never heard of cannot be verified — and cannot be refunded
    // either. Blocking it forever would strand the feed; proceed, but say so.
    const code = (err as { code?: string })?.code
    if (code === "resource_missing") {
      console.warn(`[stripe-sync] Charge ${chargeId} not found in Stripe — proceeding unchecked.`)
      return "unchecked"
    }
    // Anything else (network, 5xx, rate limit) is transient: do NOT settle on a guess.
    console.error(`[stripe-sync] Could not re-check charge ${chargeId} — deferring:`, err)
    return "defer"
  }
}

/**
 * Sync historical Stripe charges into td_bank_feeds.
 * @param options.daysBack How many days of history to fetch (default 90)
 */
export async function syncStripeCharges(
  options?: { daysBack?: number }
): Promise<SyncResult> {
  const stripe = getStripe()
  if (!stripe) {
    return { ok: false, synced: 0, skipped: 0, total: 0, error: "STRIPE_SECRET_KEY not set" }
  }

  const daysBack = options?.daysBack ?? 90
  const sinceTimestamp = Math.floor(Date.now() / 1000) - daysBack * 86400

  let synced = 0
  let skipped = 0
  let total = 0
  let startingAfter: string | undefined

  // Paginate through all charges
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Expand the PaymentIntent. Stripe does not copy Checkout Session metadata onto
    // the Charge, so `charge.metadata` is empty for every payment we have ever taken —
    // which is why the invoice number never reached reconciliation. Rather than betting
    // on Stripe's inheritance rules (that bet IS the bug), read the PaymentIntent's own
    // metadata directly. This also gives the matcher the PaymentIntent id, which is the
    // certain link back to the invoice our webhook already marked paid.
    const charges = await stripe.charges.list({
      limit: 100,
      created: { gte: sinceTimestamp },
      expand: ["data.payment_intent"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })

    for (const charge of charges.data) {
      total++

      // Skip non-succeeded, refunded, or zero-amount charges
      if (charge.status !== "succeeded" || charge.refunded || charge.amount <= 0) {
        skipped++
        continue
      }

      // The PaymentIntent carries the metadata we actually set (see stripe-checkout.ts).
      // The charge's own metadata is empty on every Checkout-created payment.
      const pi =
        charge.payment_intent && typeof charge.payment_intent === "object"
          ? charge.payment_intent
          : null
      const piMeta = (pi?.metadata ?? {}) as Record<string, string | undefined>

      const clientEmail =
        charge.billing_details?.email ||
        charge.metadata?.client_email ||
        piMeta.client_email ||
        null

      const senderName =
        charge.billing_details?.name ||
        charge.metadata?.client_name ||
        piMeta.client_name ||
        clientEmail ||
        charge.description ||
        "Unknown"

      // The invoice number is the reference that makes reconciliation certain.
      // Read it from the PaymentIntent first — that is where it now lives.
      const senderReference =
        piMeta.invoice_number ||
        charge.metadata?.invoice_number ||
        piMeta.offer_token ||
        charge.metadata?.offer_token ||
        null

      // Build a human-readable memo with the most useful fields first
      const cardInfo = (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const card = (charge.payment_method_details as any)?.card
        if (!card) return null
        return `${card.brand ?? "card"} ••••${card.last4 ?? ""}`
      })()

      const invoiceNumber = piMeta.invoice_number || charge.metadata?.invoice_number || null
      const offerToken = piMeta.offer_token || charge.metadata?.offer_token || null
      const contractType = piMeta.contract_type || charge.metadata?.contract_type || null

      const memoParts = [
        charge.description,
        clientEmail ? `email: ${clientEmail}` : null,
        contractType ? `service: ${contractType}` : null,
        invoiceNumber ? `inv: ${invoiceNumber}` : null,
        offerToken ? `offer: ${offerToken}` : null,
        cardInfo,
      ].filter(Boolean)
      const memo = memoParts.join(" | ") || null

      const row = {
        source: "stripe" as const,
        external_id: charge.id,
        transaction_date: new Date(charge.created * 1000).toISOString(),
        amount: charge.amount / 100,
        currency: charge.currency.toUpperCase(),
        sender_name: senderName,
        sender_reference: senderReference,
        memo: memo || null,
        raw_data: charge as unknown as Json,
        status: "unmatched",
      }

      // Upsert — skip if external_id already exists
      const { error } = await supabaseAdmin
        .from("td_bank_feeds")
        .upsert(row, { onConflict: "external_id", ignoreDuplicates: true })

      if (error) {
        console.error(`[stripe-sync] Failed to upsert ${charge.id}:`, error.message)
        skipped++
      } else {
        synced++
      }
    }

    // Check for more pages
    if (!charges.has_more || charges.data.length === 0) {
      break
    }

    startingAfter = charges.data[charges.data.length - 1].id
  }

  console.warn(
    `[stripe-sync] Done: ${synced} synced, ${skipped} skipped, ${total} total (${daysBack} days)`
  )

  return { ok: true, synced, skipped, total }
}
