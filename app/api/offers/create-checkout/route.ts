import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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
      .select("token, client_name, client_email, services, cost_summary, contract_type, selected_services, language, lead_id, payment_type")
      .eq("token", token)
      .single()

    if (oErr || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // Use selected_services from DB (saved at sign time) or from request body
    const selectedServices: string[] = body.selected_services
      || (Array.isArray(offer.selected_services) ? offer.selected_services : [])

    // Calculate total from selected services
    const services = Array.isArray(offer.services) ? offer.services : []
    let total = 0
    let currency: "usd" | "eur" = "eur"
    const selectedNames: string[] = []

    for (const svc of services) {
      const name = svc.name || ""
      const isOptional = !!svc.optional
      const isSelected = !isOptional || selectedServices.includes(name)

      if (!isSelected) continue

      // Parse price (e.g. "EUR2,500", "$500", "Included")
      const priceStr = String(svc.price || "0")
      const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, ""))

      if (!isNaN(priceNum) && priceNum > 0) {
        total += priceNum
        selectedNames.push(name)
      }

      // Detect currency from price string
      if (/\$|usd/i.test(priceStr)) currency = "usd"
      else if (/EUR|euro/i.test(priceStr)) currency = "eur"
    }

    // Fallback: if no parseable prices, use cost_summary[0].total
    if (total === 0 && Array.isArray(offer.cost_summary) && offer.cost_summary.length > 0) {
      const firstTotal = String(offer.cost_summary[0]?.total || "0")
      total = parseFloat(firstTotal.replace(/[^0-9.]/g, ""))
      if (/\$|usd/i.test(firstTotal)) currency = "usd"
    }

    if (total <= 0) {
      return NextResponse.json({ error: "Could not determine payment amount" }, { status: 400 })
    }

    const cardAmount = Math.round(total * 1.05) // 5% card surcharge
    const currencySymbol = currency === "eur" ? "EUR" : "$"

    // Create Stripe Checkout session
    const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
    const stripeResult = await createStripeCheckoutSession({
      clientName: offer.client_name || "Client",
      amount: total,
      currency,
      contractType: offer.contract_type || "formation",
      serviceName: selectedNames.join(" + ") || undefined,
      clientEmail: offer.client_email || undefined,
      offerToken: token,
      leadId: offer.lead_id || undefined,
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
