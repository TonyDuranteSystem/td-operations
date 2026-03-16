/**
 * Offer Signed Webhook
 *
 * Called by the contract page after a client signs.
 * Creates a pending_activation record to track the payment wait.
 * If the offer has Whop payment links → await Whop webhook.
 * If bank transfer → cron check-wire-payments will match it.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { offer_token } = body

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Get offer details
    const { data: offer, error: offerErr } = await supabase
      .from("offers")
      .select("*")
      .eq("token", offer_token)
      .single()

    if (offerErr || !offer) {
      console.error("[offer-signed] Offer not found:", offer_token, offerErr?.message)
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // Check if pending_activation already exists
    const { data: existing } = await supabase
      .from("pending_activations")
      .select("id")
      .eq("offer_token", offer_token)
      .limit(1)

    if (existing && existing.length > 0) {
      console.log("[offer-signed] Pending activation already exists for:", offer_token)
      return NextResponse.json({ ok: true, message: "Already pending" })
    }

    // Determine payment method from offer
    const hasWhop = offer.payment_links && offer.payment_links.length > 0
    const hasBank = !!offer.bank_details
    const paymentMethod = hasWhop ? "whop" : hasBank ? "bank_transfer" : "unknown"

    // Calculate total from cost_summary (first section = setup/initial payment)
    let totalAmount = 0
    const summaryArr = Array.isArray(offer.cost_summary)
      ? offer.cost_summary
      : typeof offer.cost_summary === "string"
        ? (() => { try { return JSON.parse(offer.cost_summary) } catch { return [] } })()
        : []

    if (summaryArr.length > 0) {
      // Use first section's total (setup payment the client needs to make)
      const section = summaryArr[0]
      const raw = section.total || section.total_label || ""
      // Extract number: strip currency symbols, handle European format (€3.000 = 3000, €2,500 = 2500)
      const numStr = raw.replace(/[^0-9.,]/g, "").trim()
      if (numStr) {
        // Detect European format: "3.000" (dot as thousands) vs "3,000" (comma as thousands)
        // If has dot followed by 3 digits at end → European thousands separator
        if (/\.\d{3}$/.test(numStr) && !numStr.includes(",")) {
          totalAmount = parseFloat(numStr.replace(/\./g, ""))
        } else {
          // Standard: remove commas, parse
          totalAmount = parseFloat(numStr.replace(",", ""))
        }
      }
    }

    // Create pending_activation
    const { data: activation, error: actErr } = await supabase
      .from("pending_activations")
      .insert({
        offer_token,
        lead_id: offer.lead_id || null,
        client_name: offer.client_name,
        client_email: offer.client_email,
        amount: totalAmount || null,
        currency: (() => {
          // Detect from cost_summary first section
          const raw = summaryArr[0]?.total || summaryArr[0]?.total_label || ""
          if (raw.includes("€") || raw.toUpperCase().includes("EUR")) return "EUR"
          return "USD"
        })(),
        payment_method: paymentMethod,
        status: "awaiting_payment",
        signed_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (actErr) {
      console.error("[offer-signed] Failed to create pending_activation:", actErr.message)
      return NextResponse.json({ error: "Failed to create activation" }, { status: 500 })
    }

    console.log(`[offer-signed] Created pending_activation ${activation.id} for ${offer.client_name} (${paymentMethod})`)

    // Log action
    await supabase.from("action_log").insert({
      action_type: "offer_signed",
      entity_type: "pending_activations",
      entity_id: activation.id,
      details: {
        offer_token,
        client_name: offer.client_name,
        payment_method: paymentMethod,
        amount: totalAmount,
      },
    })

    return NextResponse.json({ ok: true, activation_id: activation.id })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[offer-signed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
