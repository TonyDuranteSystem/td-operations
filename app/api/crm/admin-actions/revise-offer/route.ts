/**
 * POST /api/crm/admin-actions/revise-offer
 *
 * Creates a new draft offer (v2+) from an existing published offer.
 * The original offer is marked 'superseded' with a pointer to the new version.
 * The original is PRESERVED — never deleted or modified beyond status + superseded_by.
 *
 * This is NOT resend (same version, same offer).
 * This is revise: new version, old one superseded, history preserved.
 *
 * Guards:
 * - Cannot revise a draft (edit it directly instead)
 * - Cannot revise a signed/completed offer (history must be preserved)
 * - Cannot revise an already superseded offer (revise the latest version)
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { getBankDetailsByPreference, type BankPreference } from "@/app/offer/[token]/contract/bank-defaults"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Fetch the original offer
    const { data: original, error: fetchErr } = await supabaseAdmin
      .from("offers")
      .select("*")
      .eq("token", offer_token)
      .single()

    if (fetchErr || !original) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // Status guards
    if (original.status === "draft") {
      return NextResponse.json(
        { error: "Cannot revise a draft — edit it directly instead." },
        { status: 400 }
      )
    }

    if (original.status === "signed" || original.status === "completed") {
      return NextResponse.json(
        { error: "Cannot revise a signed/completed offer — history must be preserved." },
        { status: 400 }
      )
    }

    if (original.status === "superseded") {
      return NextResponse.json(
        { error: "This offer is already superseded — revise the latest version instead." },
        { status: 400 }
      )
    }

    const newVersion = (original.version || 1) + 1
    const newToken = `${offer_token}-v${newVersion}`

    // Check for token collision
    const { data: tokenCheck } = await supabaseAdmin
      .from("offers")
      .select("token")
      .eq("token", newToken)
      .maybeSingle()

    const finalToken = tokenCheck
      ? `${newToken}-${Date.now().toString(36).slice(-4)}`
      : newToken

    // Resolve bank details for the new draft
    const currency = original.currency || "EUR"
    const bankPref = (original.bank_details as Record<string, unknown>)?.bank_preference as string || "auto"
    const bankDetails = getBankDetailsByPreference(
      bankPref as BankPreference,
      currency
    )

    // Create new draft as copy of original
    const { error: insertErr } = await supabaseAdmin
      .from("offers")
      .insert({
        token: finalToken,
        client_name: original.client_name,
        client_email: original.client_email,
        language: original.language,
        offer_date: new Date().toISOString().split("T")[0],
        status: "draft",
        payment_type: original.payment_type,
        contract_type: original.contract_type,
        services: original.services,
        cost_summary: original.cost_summary,
        recurring_costs: original.recurring_costs,
        bundled_pipelines: original.bundled_pipelines,
        bank_details: bankDetails,
        lead_id: original.lead_id,
        account_id: original.account_id,
        required_documents: original.required_documents,
        issues: original.issues,
        admin_notes: original.admin_notes,
        currency: original.currency,
        referrer_name: original.referrer_name,
        referrer_type: original.referrer_type,
        view_count: 0,
        version: newVersion,
      })
      .select("token, access_code, status, version")
      .single()

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    // Mark original as superseded (only changes status + superseded_by — nothing else)
    await supabaseAdmin
      .from("offers")
      .update({
        status: "superseded",
        superseded_by: finalToken,
      })
      .eq("token", offer_token)

    // Update lead to point to new offer
    if (original.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({
          offer_status: "Draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", original.lead_id)
    }

    logAction({
      actor: "crm-admin",
      action_type: "create",
      table_name: "offers",
      record_id: finalToken,
      summary: `Revised offer "${offer_token}" → v${newVersion} "${finalToken}"`,
      details: {
        original_token: offer_token,
        new_token: finalToken,
        version: newVersion,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      success: true,
      token: finalToken,
      version: newVersion,
      original_token: offer_token,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[revise-offer] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
