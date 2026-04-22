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

  const amount = Number(payment.amount)
  if (!amount || amount <= 0) {
    return new NextResponse("This invoice has an invalid amount. Please contact support.", { status: 400 })
  }

  const rawCurrency = (payment.amount_currency || "USD").toString().toLowerCase()
  if (rawCurrency !== "usd" && rawCurrency !== "eur") {
    return new NextResponse(`This invoice uses an unsupported currency. Please contact support.`, { status: 400 })
  }
  const currency = rawCurrency as "usd" | "eur"

  // Resolve recipient email + display name (same priority as
  // /api/workflows/create-invoice-checkout: contact_id → account owner →
  // account.communication_email).
  let clientName = "Client"
  let clientEmail: string | undefined
  let accountCommunicationEmail: string | null = null

  if (payment.account_id) {
    const { data: account } = await supabase
      .from("accounts")
      .select("company_name, communication_email")
      .eq("id", payment.account_id)
      .single()
    if (account?.company_name) clientName = account.company_name
    if (account?.communication_email) accountCommunicationEmail = account.communication_email
  }

  if (payment.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("email, full_name")
      .eq("id", payment.contact_id)
      .single()
    if (contact?.email) clientEmail = contact.email
    if (!payment.account_id && contact?.full_name) clientName = contact.full_name
  } else if (payment.account_id) {
    const { data: link } = await supabase
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", payment.account_id)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle()

    if (link?.contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("email")
        .eq("id", link.contact_id)
        .single()
      if (contact?.email) clientEmail = contact.email
    }
  }

  if (!clientEmail && accountCommunicationEmail) {
    clientEmail = accountCommunicationEmail
  }

  if (!clientEmail) {
    return new NextResponse(
      "Could not determine your email for payment. Please contact support.",
      { status: 500 }
    )
  }

  // Create Stripe Checkout session via shared helper
  const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
  const result = await createStripeCheckoutSession({
    clientName,
    amount,
    currency,
    contractType: "annual_renewal",
    serviceName: payment.description || "Invoice Payment",
    clientEmail,
    invoiceNumber: payment.invoice_number || undefined,
  })

  if (!result.success || !result.checkoutUrl) {
    console.error("[pay-redirect] Stripe session creation failed:", result.error)
    return new NextResponse(
      "Could not start card payment right now. Please try again in a moment or contact support.",
      { status: 502 }
    )
  }

  return NextResponse.redirect(result.checkoutUrl, 303)
}
