/**
 * POST /api/crm/admin-actions/reset-offer
 *
 * Admin-only. Resets an offer to draft status:
 *   - Sets offer status to 'draft', clears payment_links
 *   - Deletes contracts + pending_activations
 * Client can re-sign fresh after reset.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Get offer for audit
    const { data: offer } = await supabaseAdmin
      .from("offers")
      .select("token, lead_id, client_name, status")
      .eq("token", offer_token)
      .single()

    if (!offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    const cleaned: Record<string, number> = {
      contracts: 0,
      pending_activations: 0,
    }

    // 1. Delete contracts
    const { count: cCount } = await supabaseAdmin
      .from("contracts")
      .delete({ count: "exact" })
      .eq("offer_token", offer_token)
    cleaned.contracts = cCount ?? 0

    // 2. Delete pending_activations
    const { count: aCount } = await supabaseAdmin
      .from("pending_activations")
      .delete({ count: "exact" })
      .eq("offer_token", offer_token)
    cleaned.pending_activations = aCount ?? 0

    // 3. Reset offer to draft
    const { error: updateErr } = await supabaseAdmin
      .from("offers")
      .update({
        status: "draft",
        payment_links: null,
        updated_at: new Date().toISOString(),
      })
      .eq("token", offer_token)

    if (updateErr) {
      return NextResponse.json(
        { error: `Failed to reset offer: ${updateErr.message}` },
        { status: 500 }
      )
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "offers",
      record_id: offer_token,
      summary: `Reset offer "${offer_token}" to draft (deleted ${cleaned.contracts} contracts, ${cleaned.pending_activations} activations)`,
      details: {
        offer_token,
        lead_id: offer.lead_id,
        previous_status: offer.status,
        cleaned,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Reset offer ${offer_token} to draft`,
      cleaned,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
