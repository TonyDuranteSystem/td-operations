import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { INTERNAL_BASE_URL } from "@/lib/config"

export async function POST(req: NextRequest) {
  // Block in production
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (supabaseUrl.includes("ydzipybqeebtpcvsbtvs")) {
    return NextResponse.json(
      { error: "Sandbox simulator is not available in production" },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body?.offer_token) {
    return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
  }

  const { offer_token, contract_type } = body as {
    offer_token: string
    contract_type?: string
  }

  // Look up the offer (no status restriction in sandbox)
  const { data: offer, error: offerErr } = await supabase
    .from("offers")
    .select("token, client_name, client_email, lead_id, currency, contract_type, cost_summary")
    .eq("token", offer_token)
    .single()

  if (offerErr || !offer) {
    return NextResponse.json({ error: "Offer not found" }, { status: 404 })
  }

  const clientName = offer.client_name ?? "Sandbox Client"
  const clientEmail = offer.client_email ?? "sandbox@test.local"
  const resolvedContractType = contract_type ?? offer.contract_type ?? "formation"
  const currency = (offer.currency as string | null) ?? "USD"

  // Derive amount from cost_summary[0].total if available
  const summaryArr = Array.isArray(offer.cost_summary) ? offer.cost_summary as Array<Record<string, unknown>> : []
  const rawTotal = String(summaryArr[0]?.total ?? summaryArr[0]?.total_label ?? "0")
  const amount = parseFloat(rawTotal.replace(/[^0-9.]/g, "")) || 0
  const now = new Date().toISOString()

  // Upsert pending_activation
  const { data: existing } = await supabase
    .from("pending_activations")
    .select("id, status, activated_at")
    .eq("offer_token", offer_token)
    .maybeSingle()

  let pendingActivationId: string

  if (existing) {
    if (existing.activated_at) {
      return NextResponse.json(
        { error: "Already activated", pending_activation_id: existing.id },
        { status: 409 },
      )
    }
    const { data: updated, error: updateErr } = await supabase
      .from("pending_activations")
      .update({
        status: "payment_confirmed",
        payment_confirmed_at: now,
        payment_method: "sandbox",
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("id")
      .single()

    if (updateErr || !updated) {
      return NextResponse.json(
        { error: "Failed to update pending_activation: " + (updateErr?.message ?? "unknown") },
        { status: 500 },
      )
    }
    pendingActivationId = updated.id
  } else {
    const { data: created, error: createErr } = await supabase
      .from("pending_activations")
      .insert({
        offer_token,
        lead_id: (offer.lead_id as string | null) ?? null,
        client_name: clientName,
        client_email: clientEmail,
        amount: amount || null,
        currency,
        payment_method: "sandbox",
        status: "payment_confirmed",
        signed_at: now,
        payment_confirmed_at: now,
      })
      .select("id")
      .single()

    if (createErr || !created) {
      return NextResponse.json(
        { error: "Failed to create pending_activation: " + (createErr?.message ?? "unknown") },
        { status: 500 },
      )
    }
    pendingActivationId = created.id
  }

  // Create payment record
  const today = new Date().toISOString().split("T")[0]
  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      amount: amount || 0,
      amount_paid: amount || 0,
      amount_currency: currency as "USD" | "EUR",
      paid_date: today,
      status: "Paid",
      payment_method: "Sandbox",
      description: `${resolvedContractType} — ${clientName} (SANDBOX)`,
      notes: `Sandbox simulate-payment for offer_token=${offer_token}, pending_activation_id=${pendingActivationId}`,
      is_test: true,
    })
    .select("id")
    .single()

  if (payErr || !payment) {
    return NextResponse.json(
      { error: "Failed to create payment record: " + (payErr?.message ?? "unknown") },
      { status: 500 },
    )
  }

  // Call activate-service workflow
  const activateRes = await fetch(
    `${INTERNAL_BASE_URL}/api/workflows/activate-service`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ pending_activation_id: pendingActivationId }),
    },
  )

  const activateBody = await activateRes.json().catch(() => ({ error: "Invalid response" }))

  return NextResponse.json({
    ok: activateRes.ok,
    pending_activation_id: pendingActivationId,
    payment_id: payment.id,
    contract_type: resolvedContractType,
    activate_status: activateRes.status,
    activate_result: activateBody,
  })
}
