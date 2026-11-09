/**
 * Stable pay redirect — /pay/<opaque-token>
 *
 * Invoices emailed to customers include a URL like
 *   https://app.tonydurante.us/pay/<opaque-token>
 * When clicked, this route:
 *   1. Looks up the payment by pay_token (token is URL-safe, 32 bytes entropy)
 *   2. If the payment is already Paid → 302 to /pay/<token>/thanks (static page)
 *   3. Otherwise: generates a fresh Stripe Checkout session for the payment
 *      and 302-redirects to the Stripe URL
 *
 * Why a redirect instead of an expiring Stripe URL in the email:
 *   - Stripe checkout sessions expire ~24h by default. An email link that
 *     went out 30 days ago would be dead without this indirection.
 *   - Regenerating on click means the pay link in the email is stable for
 *     the life of the invoice and never breaks.
 *
 * Security:
 *   - The token is opaque (crypto.randomBytes(32).toString('base64url'))
 *     and stored in payments.pay_token with a partial unique index.
 *   - Knowing an invoice_number or UUID does NOT grant access — only the
 *     pay_token does. Tokens are only ever emailed to the bill-to party.
 *   - No Supabase auth (middleware bypass via PUBLIC_PREFIXES '/pay').
 *
 * Scope: Phase 1 foundation. Does NOT currently pass a Stripe idempotency
 * key; rapid double-clicks produce two valid sessions but the webhook marks
 * the payment Paid atomically, so a second click on an already-paid
 * payment hits the "already paid" branch. Hardening this to a single
 * session via idempotency_key is a follow-up.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { APP_BASE_URL } from "@/lib/config"
import { resolvePaymentRecipient } from "@/lib/portal/resolve-payment-recipient"
import { getCardQuote, stripeProductName } from "@/lib/payments/card-quote"
import { claimPaymentForCharge, releasePaymentClaim, recordCheckoutSessionId, CLIENT_CLAIM_TTL_MS } from "@/lib/operations/autopay-claim"

export const dynamic = "force-dynamic"

// Token shape: base64url, 32 bytes → ~43 chars. Accept a little wider for
// future-proofing but still enforce reasonable bounds.
const TOKEN_REGEX = /^[A-Za-z0-9_-]{32,128}$/

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const token = params.token

  if (!token || !TOKEN_REGEX.test(token)) {
    return new NextResponse("Invalid pay link.", { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Look up the payment by token. maybeSingle() so a bad token returns null
  // rather than throwing.
  const { data: payment, error: pErr } = await supabase
    .from("payments")
    .select("id, account_id, contact_id, amount, amount_currency, status, description, invoice_number, pay_token")
    .eq("pay_token", token)
    .maybeSingle()

  if (pErr || !payment) {
    // Do NOT leak whether the token existed — opaque 404.
    return new NextResponse("This pay link is not valid.", { status: 404 })
  }

  // Already paid → send the clicker to a neutral confirmation page.
  if (payment.status === "Paid") {
    return NextResponse.redirect(`${APP_BASE_URL}/pay/${token}/thanks`, 303)
  }

  // What the card is charged comes from the same place as the portal Pay button
  // (lib/payments/card-quote.ts): what is STILL OWED on the invoice plus the card fee on
  // it. One rule for every Pay button — wire has no fee, card has the invoice's fee. This
  // link used to charge the whole invoice with no fee, ignoring anything already paid.
  const quote = await getCardQuote(payment.id)
  if (quote.ok === false) {
    // A row flagged Paid on its invoice status only (status column not yet Paid) is paid:
    // same thank-you page as the check above.
    if (quote.reason === "paid") {
      return NextResponse.redirect(`${APP_BASE_URL}/pay/${token}/thanks`, 303)
    }
    const message =
      quote.reason === "unavailable"
        ? "We could not look up this invoice right now. Please try again in a minute."
      : quote.reason === "currency"
        ? "This invoice uses an unsupported currency. Please contact support."
        : quote.reason === "nothing_owed"
          ? "Nothing is owed on this invoice. If you think this is wrong, please contact support."
          : quote.reason === "too_small"
            ? "The remaining balance is too small to pay by card. Please pay it by bank transfer or contact support."
            : quote.reason === "closed"
              ? "This invoice is closed and cannot be paid. Please contact support."
              : "This pay link is not valid."
    return new NextResponse(message, { status: quote.reason === "not_found" ? 404 : quote.reason === "unavailable" ? 503 : 400 })
  }

  // Claim this payment before touching Stripe — the card-autopay cron
  // (dev job 10995181) can independently act on any payments row, including
  // one reached through this older email-link route, not just the portal
  // Pay button. Whichever side wins may act; the other must not (see
  // lib/operations/autopay-claim.ts).
  const claimed = await claimPaymentForCharge(payment.id, CLIENT_CLAIM_TTL_MS)
  if (!claimed) {
    return new NextResponse(
      "This invoice is being processed right now. Please try again in a minute.",
      { status: 409 }
    )
  }

  const recipient = await resolvePaymentRecipient(payment, supabase)
  if (!recipient) {
    await releasePaymentClaim(payment.id)
    return new NextResponse(
      "Could not determine your email for payment. Please contact support.",
      { status: 500 }
    )
  }
  const { email: clientEmail, name: clientName } = recipient

  // Create Stripe Checkout session via shared helper
  const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
  const result = await createStripeCheckoutSession({
    clientName,
    amount: quote.cardTotal,
    currency: quote.currency,
    contractType: "annual_renewal",
    serviceName: stripeProductName(payment.description, quote),
    clientEmail,
    invoiceNumber: payment.invoice_number || undefined,
  })

  if (!result.success || !result.checkoutUrl) {
    console.error("[pay-redirect] Stripe session creation failed:", result.error)
    await releasePaymentClaim(payment.id)
    return new NextResponse(
      "Could not start card payment right now. Please try again in a moment or contact support.",
      { status: 502 }
    )
  }

  // Record the live session so the card-autopay cron can actively expire it
  // before charging, then release the claim — it only needed to cover
  // creating this one Stripe object, not the session's lifetime.
  if (result.sessionId) {
    await recordCheckoutSessionId(payment.id, result.sessionId)
  }
  await releasePaymentClaim(payment.id)

  return NextResponse.redirect(result.checkoutUrl, 303)
}
