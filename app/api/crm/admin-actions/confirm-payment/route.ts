/**
 * POST /api/crm/admin-actions/confirm-payment
 *
 * Admin-only endpoint to confirm a lead's payment and trigger the activation chain.
 * Two modes:
 *   1. With offer — pre-filled from offer data (90% of cases)
 *   2. Without offer — admin fills everything manually (legacy/exceptions)
 *
 * This endpoint:
 *   a. Creates/updates pending_activation with pessimistic lock
 *   b. Records payment in payments table
 *   c. Calls POST /api/workflows/activate-service (SAME chain as Whop webhook)
 *   d. Updates lead status to Converted
 *   e. Logs everything to action_log
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

interface ConfirmPaymentBody {
  lead_id: string
  // Payment info
  payment_method: string // "wire" | "card" | "other"
  payment_date: string   // YYYY-MM-DD
  payment_reference?: string
  // Offer-derived (Mode 1) or manual (Mode 2)
  amount: number
  currency: "USD" | "EUR"
  contract_type: "formation" | "onboarding" | "tax_return" | "itin"
  bundled_pipelines: string[]
  // Optional manual overrides (Mode 2 only)
  annual_1st_installment?: number
  annual_2nd_installment?: number
  reason?: string
}

export async function POST(request: Request) {
  // Auth check — admin only
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "confirm_payment")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body: ConfirmPaymentBody = await request.json()
    const {
      lead_id,
      payment_method,
      payment_date,
      payment_reference,
      amount,
      currency,
      contract_type,
      bundled_pipelines,
      reason,
    } = body

    if (!lead_id || !amount || !currency || !contract_type) {
      return NextResponse.json(
        { error: "Missing required fields: lead_id, amount, currency, contract_type" },
        { status: 400 }
      )
    }

    // 1. Get lead
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single()

    if (leadErr || !lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    if (lead.status === "Converted") {
      return NextResponse.json({ error: "Lead is already converted" }, { status: 409 })
    }

    // 2. Get offer (may not exist for legacy leads)
    const { data: offer } = await supabaseAdmin
      .from("offers")
      .select("token, status, contract_type, bundled_pipelines, cost_summary, client_email, client_name")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // 3. Handle pending_activation with pessimistic lock
    let activationId: string | null = null

    // Check if pending_activation exists for this lead
    const { data: existingActivation } = await supabaseAdmin
      .from("pending_activations")
      .select("id, status")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingActivation) {
      if (existingActivation.status === "activated") {
        return NextResponse.json(
          { error: "This lead already has an activated service. Check the contact/account." },
          { status: 409 }
        )
      }

      // Pessimistic lock: try to claim it
      const { data: locked, error: lockErr } = await supabaseAdmin
        .from("pending_activations")
        .update({
          status: "payment_confirmed",
          amount,
          currency,
          payment_method: payment_method || "wire",
          payment_confirmed_at: new Date().toISOString(),
          notes: reason
            ? `Admin confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}. Reason: ${reason}`
            : `Admin confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingActivation.id)
        .in("status", ["awaiting_payment", "pending_confirmation"])
        .select("id")
        .single()

      if (lockErr || !locked) {
        return NextResponse.json(
          { error: "This activation is already being processed by another session." },
          { status: 409 }
        )
      }
      activationId = locked.id
    } else {
      // No pending_activation exists (legacy lead, no offer signed)
      // Create one from admin dialog data
      const { data: newActivation, error: createErr } = await supabaseAdmin
        .from("pending_activations")
        .insert({
          offer_token: offer?.token || `admin-${lead_id.slice(0, 8)}`,
          lead_id,
          client_name: lead.full_name,
          client_email: lead.email,
          amount,
          currency,
          payment_method: payment_method || "wire",
          status: "payment_confirmed",
          payment_confirmed_at: new Date().toISOString(),
          notes: reason
            ? `Admin created + confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}. Reason: ${reason}`
            : `Admin created + confirmed. Method: ${payment_method}. Ref: ${payment_reference || "N/A"}`,
        })
        .select("id")
        .single()

      if (createErr || !newActivation) {
        return NextResponse.json(
          { error: `Failed to create activation: ${createErr?.message}` },
          { status: 500 }
        )
      }
      activationId = newActivation.id
    }

    // 4. Update offer bundled_pipelines if needed (for Mode 2 — no offer or missing pipelines)
    if (offer?.token && bundled_pipelines?.length > 0) {
      const existingPipelines = Array.isArray(offer.bundled_pipelines) ? offer.bundled_pipelines : []
      if (existingPipelines.length === 0) {
        await supabaseAdmin
          .from("offers")
          .update({
            bundled_pipelines,
            contract_type,
            updated_at: new Date().toISOString(),
          })
          .eq("token", offer.token)
      }
    } else if (!offer && bundled_pipelines?.length > 0) {
      // Create a minimal offer record for legacy leads so activate-service can read it
      await supabaseAdmin
        .from("offers")
        .insert({
          token: `admin-${lead_id.slice(0, 8)}-${Date.now()}`,
          lead_id,
          client_name: lead.full_name,
          client_email: lead.email,
          language: lead.language === "Italian" ? "it" : "en",
          contract_type,
          bundled_pipelines,
          payment_type: "bank_transfer",
          status: "completed",
          services: [],
          cost_summary: [{ label: "Admin-confirmed payment", total: `${currency} ${amount}` }],
        })

      // Update the activation to reference this new offer
      await supabaseAdmin
        .from("pending_activations")
        .update({ offer_token: `admin-${lead_id.slice(0, 8)}-${Date.now()}` })
        .eq("id", activationId)
    }

    // 5. Create payment record
    // Find account_id if a contact already exists for this lead
    let accountId: string | null = null
    if (lead.email) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .ilike("email", lead.email)
        .limit(1)
        .maybeSingle()

      if (contact) {
        const { data: ac } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", contact.id)
          .limit(1)
          .maybeSingle()
        accountId = ac?.account_id || null
      }
    }

    const { error: paymentErr } = await supabaseAdmin
      .from("payments")
      .insert({
        account_id: accountId,
        description: `${contract_type} - ${lead.full_name} (admin confirmed)`,
        amount,
        amount_currency: currency,
        payment_method: payment_method || "wire",
        payment_date: payment_date || new Date().toISOString().split("T")[0],
        status: "paid",
        notes: payment_reference ? `Ref: ${payment_reference}` : undefined,
        is_test: lead.is_test || false,
      })

    if (paymentErr) {
      console.error("[confirm-payment] Payment insert error:", paymentErr.message)
      // Continue anyway — payment record is secondary, activation is critical
      // But log it so admin knows
      logAction({
        actor: "crm-admin",
        action_type: "error",
        table_name: "payments",
        summary: `Payment record failed for ${lead.full_name}: ${paymentErr.message}`,
        details: { lead_id, error: paymentErr.message },
      })
    }

    // 6. Update lead status
    await supabaseAdmin
      .from("leads")
      .update({
        status: "Converted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id)

    // 7. Call activate-service (SAME chain as Whop webhook)
    let activationResult = null
    try {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"

      const res = await fetch(`${baseUrl}/api/workflows/activate-service`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ pending_activation_id: activationId }),
      })

      activationResult = await res.json()
    } catch (err) {
      console.error("[confirm-payment] activate-service call failed:", err)
      activationResult = { error: err instanceof Error ? err.message : String(err) }
    }

    // 8. Log to action_log
    logAction({
      actor: "crm-admin",
      action_type: "confirm_payment",
      table_name: "pending_activations",
      record_id: activationId || undefined,
      account_id: accountId || undefined,
      summary: `Payment confirmed by admin for ${lead.full_name}. ${currency} ${amount} via ${payment_method}. Ref: ${payment_reference || "N/A"}`,
      details: {
        lead_id,
        offer_token: offer?.token,
        activation_id: activationId,
        payment_method,
        payment_reference,
        amount,
        currency,
        contract_type,
        bundled_pipelines,
        reason,
        activation_result: activationResult,
        admin_email: user?.email,
      },
    })

    const activationOk = activationResult && !activationResult.error
    return NextResponse.json({
      ok: true,
      message: activationOk
        ? `Payment confirmed for ${lead.full_name}. Activation chain triggered successfully.`
        : `Payment confirmed for ${lead.full_name}. Activation chain had issues — check action_log.`,
      activation_id: activationId,
      activation_result: activationResult,
      activation_ok: activationOk,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[confirm-payment] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
