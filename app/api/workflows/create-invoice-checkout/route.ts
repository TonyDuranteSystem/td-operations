import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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
      .select("id, account_id, contact_id, amount, amount_currency, status, description, invoice_number")
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

    // Resolve client name + email
    // Email resolution order (first hit wins):
    //   1. payment.contact_id → contacts.email
    //   2. account_contacts owner → contacts.email
    //   3. accounts.communication_email (fallback for accounts with no linked owner)
    let clientName = "Client"
    let clientEmail: string | undefined
    let accountCommunicationEmail: string | null = null

    // Fetch account info (name + fallback email) first
    if (payment.account_id) {
      const { data: account } = await supabase
        .from("accounts")
        .select("company_name, communication_email")
        .eq("id", payment.account_id)
        .single()
      if (account?.company_name) clientName = account.company_name
      if (account?.communication_email) accountCommunicationEmail = account.communication_email
    }

    // Email: prefer direct contact_id on payment, fall back to account owner
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

    // Final fallback: account.communication_email
    if (!clientEmail && accountCommunicationEmail) {
      clientEmail = accountCommunicationEmail
    }

    if (!clientEmail) {
      return NextResponse.json(
        { error: "Could not resolve client email from payment" },
        { status: 400 }
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
      return NextResponse.json(
        { error: result.error || "Stripe session creation failed" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
      amount,
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
