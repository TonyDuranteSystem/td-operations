import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { resolveBillableSelection } from "@/lib/payments/billable-selection"
import { computeOfferPayable } from "@/lib/offers/compute-offer-totals"
import { computeCardTotal } from "@/lib/payments/card-fee"
import { resolveChargeRate } from "@/lib/payments/card-fee-config"

export const dynamic = "force-dynamic"

/**
 * POST /api/offers/create-checkout
 *
 * Creates a Stripe Checkout session based on the client's selected services.
 * Called AFTER signing (deferred checkout) so the amount matches what the client chose.
 *
 * Body: { token: string, selected_services?: string[] }
 * Returns: { checkoutUrl, amount, cardAmount, currency }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { token } = body as { token: string; selected_services?: string[] }

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 })
    }

    // Fresh DB client per request
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch offer
    const { data: offer, error: oErr } = await supabase
      .from("offers")
      .select("token, client_name, client_email, services, cost_summary, contract_type, selected_services, language, lead_id, payment_type, status, card_fee_rate")
      .eq("token", token)
      .single()

    if (oErr || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // SECURITY (2026-07-14, dev_task ba7bfd8d): this route is PUBLIC — token-only,
    // no session — and it used to let the REQUEST BODY override the stored
    // selection. A client who had SIGNED for an optional add-on could POST
    // `{ selected_services: [] }` and be billed for the required services only.
    // Freezing the checkboxes in the UI closes nothing; the endpoint is callable
    // directly. Once signed, the stored selection IS the contract.
    // Rules + tests: lib/payments/billable-selection.ts
    const selectedServices: string[] = resolveBillableSelection({
      status: offer.status,
      storedSelection: offer.selected_services,
      requestedSelection: body.selected_services,
    })

    // WS-A3 site #2 (dev job c0a61e44): the CHARGE amount comes from THE offer
    // amount engine — the same math the signing webhook records, so what the
    // card bills always equals the invoice of record. The engine's semantics
    // are pinned by tests/unit/compute-offer-totals.test.ts.
    //
    // Open-offer REPLAY (77 production offers, this session): identical amounts
    // everywhere; exactly ONE currency divergence — an all-EUR offer whose
    // recurring "$2,000/year" line flipped the OLD group-scan to USD (a latent
    // $-for-€ mischarge). The engine's header-based detection is correct there.
    // Engine EU-fallback handling also fixes the old plain-parse fallback
    // ("€1.500" would have charged €1.50).
    // NET EVERYWHERE (Antonio's ruling): the card charges what the invoice of
    // record says, never the gross. Before this, a client shown "Total Due Today
    // €1,243" was charged €1,575 — paying for their strategy call twice.
    const totals = computeOfferPayable({
      services: offer.services,
      cost_summary: offer.cost_summary,
      selected_services: selectedServices,
      currency: (offer as { currency?: string | null }).currency,
      credit_amount: (offer as { credit_amount?: number | null }).credit_amount,
    })
    const total = totals.net
    const currency: "usd" | "eur" = totals.currency === "EUR" ? "eur" : "usd"
    const selectedNames: string[] = totals.countedServiceNames

    if (total <= 0) {
      return NextResponse.json({ error: "Could not determine payment amount" }, { status: 400 })
    }

    // Charge base + the card fee (dev_task 6ec6872a). The rate is the one PINNED on
    // the offer — never a live/hardcoded value — so what's charged matches the signed
    // contract. The webhook books the fee onto the invoice from the ACTUAL charge.
    const cardFeeRate = await resolveChargeRate(
      (offer as { card_fee_rate?: number | string | null }).card_fee_rate,
    )
    const { cardTotal: cardAmount } = computeCardTotal(total, cardFeeRate)
    const currencySymbol = currency === "eur" ? "EUR" : "$"

    // Fetch invoice number from pending_activation (created at signing)
    let invoiceNumber: string | undefined
    const { data: activation } = await supabase
      .from("pending_activations")
      .select("portal_invoice_id")
      .eq("offer_token", token)
      .maybeSingle()

    if (activation?.portal_invoice_id) {
      const { data: inv } = await supabase
        .from("payments")
        .select("invoice_number")
        .eq("id", activation.portal_invoice_id)
        .single()
      invoiceNumber = inv?.invoice_number || undefined
    }

    // Create Stripe Checkout session
    const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
    const stripeResult = await createStripeCheckoutSession({
      clientName: offer.client_name || "Client",
      // THE MONEY FIX: charge base + card fee (was `total` = base only, which silently
      // dropped the fee on every Stripe card payment). The webhook books the fee onto
      // the invoice from session.amount_total. (dev_task 6ec6872a)
      amount: cardAmount,
      currency,
      contractType: offer.contract_type || "formation",
      serviceName: selectedNames.join(" + ") || undefined,
      clientEmail: offer.client_email || undefined,
      offerToken: token,
      leadId: offer.lead_id || undefined,
      invoiceNumber,
    })

    if (!stripeResult.success || !stripeResult.checkoutUrl) {
      return NextResponse.json({
        error: stripeResult.error || "Stripe session creation failed",
      }, { status: 500 })
    }

    // Update offer with payment links
    await supabase
      .from("offers")
      .update({
        payment_links: [{
          url: stripeResult.checkoutUrl,
          label: `Pay ${currencySymbol}${cardAmount.toLocaleString()} by Card`,
          amount: `${currencySymbol}${cardAmount.toLocaleString()}`,
          gateway: "stripe",
        }],
      })
      .eq("token", token)

    return NextResponse.json({
      checkoutUrl: stripeResult.checkoutUrl,
      sessionId: stripeResult.sessionId,
      amount: total,
      fee: cardAmount - total,
      cardFeeRate,
      cardAmount,
      currency,
      label: `${currencySymbol}${cardAmount.toLocaleString()}`,
    })
  } catch (err) {
    console.error("[create-checkout] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    )
  }
}
