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
