import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { resolvePaymentRecipient } from "@/lib/portal/resolve-payment-recipient"
import { computeCardTotal } from "@/lib/payments/card-fee"
import { resolveChargeRate } from "@/lib/payments/card-fee-config"

export const dynamic = "force-dynamic"

/**
 * POST /api/workflows/create-invoice-checkout
 *
 * Creates a Stripe Checkout session for an existing TD invoice (payments row).
 * Used to generate a pay-by-card link for a client invoice that was created via
 * portal_invoice_create / createTDInvoice, so the client can pay by card.
 *
 * Body: { payment_id: string }
 * Returns: { checkoutUrl, sessionId, amount, currency, invoiceNumber }
 *
 * Auth model: same as /api/offers/create-checkout — public endpoint under
 * /api/workflows/ (PUBLIC_PREFIXES in middleware.ts), with the payment_id UUID
 * functioning as the shared secret. No Authorization header check.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { payment_id } = body as { payment_id?: string }

    if (!payment_id || typeof payment_id !== "string") {
      return NextResponse.json({ error: "Missing payment_id" }, { status: 400 })
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(payment_id)) {
      return NextResponse.json({ error: "Invalid payment_id format" }, { status: 400 })
    }

    // Fresh service-role Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the payment row
    const { data: payment, error: pErr } = await supabase
      .from("payments")
      .select("id, account_id, contact_id, amount, amount_currency, status, description, invoice_number, card_fee_rate")
      .eq("id", payment_id)
      .single()

    if (pErr || !payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    if (payment.status === "Paid") {
      return NextResponse.json({ error: "Payment already paid" }, { status: 400 })
    }

    const amount = Number(payment.amount)
    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    // Validate currency (createStripeCheckoutSession only accepts usd|eur)
    const rawCurrency = (payment.amount_currency || "USD").toString().toLowerCase()
    if (rawCurrency !== "usd" && rawCurrency !== "eur") {
      return NextResponse.json(
        { error: `Unsupported currency: ${payment.amount_currency}` },
        { status: 400 }
      )
    }
    const currency = rawCurrency as "usd" | "eur"

    const recipient = await resolvePaymentRecipient(payment, supabase)
    if (!recipient) {
      return NextResponse.json(
        { error: "Could not resolve client email from payment" },
        { status: 400 }
      )
    }
    const { email: clientEmail, name: clientName } = recipient

    // Charge base + card fee (dev_task 6ec6872a). Card fee uses the rate PINNED on
    // this invoice (authoritative) — the portal Pay modal shows the same number. The
    // webhook books the fee onto the invoice from the actual charge.
    const cardFeeRate = await resolveChargeRate(
      (payment as { card_fee_rate?: number | string | null }).card_fee_rate,
    )
    const { cardTotal, fee: cardFee } = computeCardTotal(amount, cardFeeRate)

    // Create Stripe Checkout session via shared helper
    const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
    const result = await createStripeCheckoutSession({
      clientName,
      amount: cardTotal,
      currency,
      contractType: "annual_renewal",
      serviceName: payment.description || "Invoice Payment",
      clientEmail,
      invoiceNumber: payment.invoice_number || undefined,
    })

    if (!result.success || !result.checkoutUrl) {
      return NextResponse.json(
        { error: result.error || "Stripe session creation failed" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
      amount,
      fee: cardFee,
      cardFeeRate,
      cardAmount: cardTotal,
      currency,
      invoiceNumber: payment.invoice_number || null,
    })
  } catch (err) {
    console.error("[create-invoice-checkout] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    )
  }
}
