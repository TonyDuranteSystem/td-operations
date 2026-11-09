import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { resolvePaymentRecipient } from "@/lib/portal/resolve-payment-recipient"
import { getCardQuote, stripeProductName } from "@/lib/payments/card-quote"
import { claimPaymentForCharge, releasePaymentClaim, recordCheckoutSessionId, CLIENT_CLAIM_TTL_MS } from "@/lib/operations/autopay-claim"

export const dynamic = "force-dynamic"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** HTTP status for a refused quote. */
function refusalStatus(reason: string): number {
  return reason === "not_found" ? 404 : reason === "unavailable" ? 503 : 400
}

/**
 * GET /api/workflows/create-invoice-checkout?payment_id=...
 *
 * The card price for an invoice, WITHOUT starting a payment: what is still owed, the
 * card fee on it and the total the card page will ask for. The portal Pay popup shows
 * exactly this, so the number on screen is the number Stripe is asked to charge (both
 * come from lib/payments/card-quote.ts). Same auth model as POST below.
 */
export async function GET(req: NextRequest) {
  try {
    const payment_id = req.nextUrl.searchParams.get("payment_id")
    if (!payment_id || !UUID_REGEX.test(payment_id)) {
      return NextResponse.json({ error: "Invalid payment_id format" }, { status: 400 })
    }

    const quote = await getCardQuote(payment_id)
    if (quote.ok === false) {
      return NextResponse.json({ error: quote.error, reason: quote.reason }, { status: refusalStatus(quote.reason) })
    }

    return NextResponse.json({
      amount: quote.balance,
      invoiceTotal: quote.invoiceTotal,
      alreadyPaid: quote.alreadyPaid,
      fee: quote.fee,
      cardFeeRate: quote.rate,
      cardAmount: quote.cardTotal,
      currency: quote.currency,
      invoiceNumber: quote.payment.invoice_number || null,
    })
  } catch (err) {
    // The raw error can carry database text — log it, show the client a plain sentence.
    console.error("[create-invoice-checkout] Quote error:", err)
    return NextResponse.json({ error: "Could not work out the card price right now. Please try again.", reason: "unavailable" }, { status: 500 })
  }
}

/**
 * POST /api/workflows/create-invoice-checkout
 *
 * Creates a Stripe Checkout session for an existing TD invoice (payments row).
 * Used to generate a pay-by-card link for a client invoice that was created via
 * portal_invoice_create / createTDInvoice, so the client can pay by card.
 *
 * What the card is charged is decided by lib/payments/card-quote.ts from the invoice's
 * live state: what is STILL OWED (the invoice minus anything already paid, e.g. by
 * wire) plus the card fee on that balance. A client who paid part of an invoice by
 * wire pays the rest — never the whole invoice again.
 *
 * Body: { payment_id: string }
 * Returns: { checkoutUrl, sessionId, amount (still owed), fee, cardFeeRate, cardAmount, currency, invoiceNumber }
 *
 * Auth model: same as /api/offers/create-checkout — public endpoint under
 * /api/workflows/ (PUBLIC_PREFIXES in middleware.ts), with the payment_id UUID
 * functioning as the shared secret. No Authorization header check.
 */
export async function POST(req: NextRequest) {
  let claimedPaymentId: string | null = null
  try {
    const body = await req.json()
    const { payment_id } = body as { payment_id?: string }

    if (!payment_id || typeof payment_id !== "string") {
      return NextResponse.json({ error: "Missing payment_id" }, { status: 400 })
    }

    // Validate UUID format
    if (!UUID_REGEX.test(payment_id)) {
      return NextResponse.json({ error: "Invalid payment_id format" }, { status: 400 })
    }

    // Quote first: it refuses a paid / closed / nothing-owed / unsupported-currency invoice
    // before we claim anything or touch Stripe.
    const quote = await getCardQuote(payment_id)
    if (quote.ok === false) {
      return NextResponse.json({ error: quote.error }, { status: refusalStatus(quote.reason) })
    }
    const { payment } = quote

    // Claim this payment before touching Stripe — the card-autopay cron can be
    // mid-charge on the same invoice right now. Whichever side wins may act;
    // the other must not (see lib/offers/autopay-claim.ts).
    const claimed = await claimPaymentForCharge(payment.id, CLIENT_CLAIM_TTL_MS)
    if (!claimed) {
      return NextResponse.json(
        { error: "This invoice is being processed right now. Please try again in a minute." },
        { status: 409 }
      )
    }
    claimedPaymentId = payment.id

    // Fresh service-role Supabase client (recipient lookup only)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const recipient = await resolvePaymentRecipient(payment, supabase)
    if (!recipient) {
      await releasePaymentClaim(claimedPaymentId)
      return NextResponse.json(
        { error: "Could not resolve client email from payment" },
        { status: 400 }
      )
    }
    const { email: clientEmail, name: clientName } = recipient

    // Create Stripe Checkout session via shared helper. The amount is the quote's card
    // total (balance + the fee on the balance); the webhook books the fee onto the
    // invoice from the actual charge, starting from the same balance.
    const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
    const result = await createStripeCheckoutSession({
      clientName,
      amount: quote.cardTotal,
      currency: quote.currency,
      contractType: "annual_renewal",
      // One line on Stripe's page: say when it is only the balance / includes the card fee.
      serviceName: stripeProductName(payment.description, quote),
      clientEmail,
      invoiceNumber: payment.invoice_number || undefined,
    })

    if (!result.success || !result.checkoutUrl) {
      await releasePaymentClaim(claimedPaymentId)
      return NextResponse.json(
        { error: result.error || "Stripe session creation failed" },
        { status: 500 }
      )
    }

    // Record the live session so the card-autopay cron can actively expire it
    // before charging (a Checkout Session can't be told to expire in under 30
    // minutes on its own). The claim itself is released now — it only needed
    // to cover creating this one Stripe object, not the session's lifetime.
    if (result.sessionId) {
      await recordCheckoutSessionId(payment.id, result.sessionId)
    }
    await releasePaymentClaim(claimedPaymentId)

    return NextResponse.json({
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
      amount: quote.balance,
      invoiceTotal: quote.invoiceTotal,
      alreadyPaid: quote.alreadyPaid,
      fee: quote.fee,
      cardFeeRate: quote.rate,
      cardAmount: quote.cardTotal,
      currency: quote.currency,
      invoiceNumber: payment.invoice_number || null,
    })
  } catch (err) {
    console.error("[create-invoice-checkout] Error:", err)
    if (claimedPaymentId) {
      await releasePaymentClaim(claimedPaymentId)
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    )
  }
}
