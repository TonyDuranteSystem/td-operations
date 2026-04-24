/**
 * Sandbox Payment Simulator
 *
 * POST /api/sandbox/simulate-payment
 *
 * Simulates the full payment confirmation → activation chain without
 * real Stripe/Whop webhooks. BLOCKED on production — only runs against
 * the sandbox Supabase project (xjcxlmlpeywtwkhstjlw).
 *
 * Flow:
 *   1. Safety check — hard-block on production ref (ydzipybqeebtpcvsbtvs)
 *   2. Look up offer by token
 *   3. Create or locate pending_activation at 'payment_confirmed'
 *   4. Call activate-service internally (same-origin fetch)
 *   5. Look up and return: contact_id, account_id, portal_tier, sd_created
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { isProductionEnvironment } from "@/lib/sandbox/guard"

export async function POST(req: NextRequest) {
  // ─── 1. Safety check ────────────────────────────────────
  if (isProductionEnvironment()) {
    return NextResponse.json(
      { error: "simulate-payment is not available in production" },
      { status: 403 },
    )
  }

  // ─── 2. Auth ─────────────────────────────────────────────
  const token = req.headers.get("authorization")?.replace("Bearer ", "")
  if (token !== process.env.API_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ─── 3. Parse body ───────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { offer_token, contract_type } = body

  if (!offer_token || typeof offer_token !== "string") {
    return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
  }
  if (!contract_type || !["formation", "onboarding"].includes(String(contract_type))) {
    return NextResponse.json(
      { error: "contract_type must be 'formation' or 'onboarding'" },
      { status: 400 },
    )
  }

  // ─── 4. Look up offer ────────────────────────────────────
  const { data: offer, error: offerErr } = await supabase
    .from("offers")
    .select("*")
    .eq("token", offer_token)
    .single()

  if (offerErr || !offer) {
    return NextResponse.json({ error: "Offer not found" }, { status: 404 })
  }

  // ─── 5. Parse amount (mirrors offer-signed logic) ────────
  const summaryArr = (
    Array.isArray(offer.cost_summary)
      ? offer.cost_summary
      : typeof offer.cost_summary === "string"
        ? (() => {
            try {
              return JSON.parse(offer.cost_summary as string)
            } catch {
              return []
            }
          })()
        : []
  ) as Array<Record<string, unknown>>

  let totalAmount = 0
  const services = (Array.isArray(offer.services) ? offer.services : []) as Array<Record<string, unknown>>
  const selectedServices = (
    Array.isArray(offer.selected_services) ? offer.selected_services : []
  ) as string[]

  for (const svc of services) {
    const isOptional = !!svc.optional
    const isSelected = !isOptional || selectedServices.includes(svc.name as string)
    if (!isSelected) continue
    const priceStr = String(svc.price || "0")
    if (/\/(year|anno|month|mese)/i.test(priceStr)) continue
    if (/includ|inclus/i.test(priceStr)) continue
    const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, ""))
    if (!isNaN(priceNum) && priceNum > 0) totalAmount += priceNum
  }

  if (totalAmount === 0 && summaryArr.length > 0) {
    const raw = String(summaryArr[0].total || summaryArr[0].total_label || "")
    const numStr = raw.replace(/[^0-9.,]/g, "").trim()
    if (numStr) {
      totalAmount =
        /\.\d{3}$/.test(numStr) && !numStr.includes(",")
          ? parseFloat(numStr.replace(/\./g, ""))
          : parseFloat(numStr.replace(",", ""))
    }
  }

  const currency = (() => {
    const raw = String(summaryArr[0]?.total || summaryArr[0]?.total_label || "")
    return raw.includes("€") || raw.toUpperCase().includes("EUR") ? "EUR" : "USD"
  })()

  // ─── 6. Find or create pending_activation ───────────────
  const { data: existing } = await supabase
    .from("pending_activations")
    .select("id, status, activated_at")
    .eq("offer_token", offer_token)
    .limit(1)
    .maybeSingle()

  let activationId: string
  let activationStatus: string

  if (existing?.activated_at) {
    activationId = existing.id
    activationStatus = "already_activated"
  } else if (existing) {
    // Exists but not yet activated — advance to payment_confirmed
    await supabase
      .from("pending_activations")
      .update({ status: "payment_confirmed" as never, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
    activationId = existing.id
    activationStatus = "advanced_to_payment_confirmed"
  } else {
    const { data: activation, error: actErr } = await supabase
      .from("pending_activations")
      .insert({
        offer_token,
        lead_id: offer.lead_id ?? null,
        client_name: offer.client_name,
        client_email: offer.client_email,
        amount: totalAmount || null,
        currency: currency as never,
        payment_method: "bank_transfer" as never,
        status: "payment_confirmed" as never,
        signed_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (actErr || !activation) {
      return NextResponse.json(
        { error: `Failed to create pending_activation: ${actErr?.message ?? "unknown"}` },
        { status: 500 },
      )
    }
    activationId = activation.id
    activationStatus = "created"
  }

  // ─── 7. Call activate-service internally ─────────────────
  let activateResult: Record<string, unknown> = {}
  let activateOk = false

  if (activationStatus !== "already_activated") {
    const origin = new URL(req.url).origin
    let activateRes: Response
    try {
      activateRes = await fetch(`${origin}/api/workflows/activate-service`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ pending_activation_id: activationId }),
      })
    } catch (err) {
      return NextResponse.json(
        {
          error: `activate-service call failed: ${err instanceof Error ? err.message : String(err)}`,
          activation_id: activationId,
        },
        { status: 500 },
      )
    }
    try {
      activateResult = await activateRes.json()
    } catch {
      return NextResponse.json(
        { error: `activate-service returned non-JSON (status ${activateRes.status})`, activation_id: activationId },
        { status: 500 },
      )
    }
    activateOk = activateRes.ok
  } else {
    activateOk = true
    activateResult = { ok: true, message: "Already activated" }
  }

  // ─── 8. Look up results ──────────────────────────────────
  const clientEmail = offer.client_email as string | null
  let contactId: string | null = null
  let accountId: string | null = null
  let portalTier: string | null = null

  if (clientEmail) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, portal_tier")
      .ilike("email", clientEmail)
      .limit(1)
      .maybeSingle()

    if (contact) {
      contactId = contact.id
      portalTier = contact.portal_tier ?? null

      const { data: link } = await supabase
        .from("account_contacts")
        .select("account_id")
        .eq("contact_id", contactId)
        .limit(1)
        .maybeSingle()

      if (link) accountId = link.account_id
    }
  }

  const sdResults = (activateResult.service_deliveries as Array<Record<string, unknown>> | undefined) ?? []
  const sdCreated = sdResults.filter((r) => r.status === "created").length

  return NextResponse.json({
    success: activateOk,
    activation_id: activationId,
    activation_status: activationStatus,
    contact_id: contactId,
    account_id: accountId,
    portal_tier: portalTier,
    sd_created: sdCreated,
    activate_service_response: activateResult,
  })
}
