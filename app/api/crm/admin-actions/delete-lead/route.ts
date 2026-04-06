/**
 * POST /api/crm/admin-actions/delete-lead
 *
 * Admin-only. Cascade-deletes a lead and all related data:
 *   1. contracts (via offer_token)
 *   2. pending_activations (via offer_token OR lead_id)
 *   3. offers (via lead_id)
 *   4. auth.users portal user (via email match)
 *   5. leads record
 *
 * Deletes in FK order to avoid constraint violations.
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
    const { lead_id } = await request.json()

    if (!lead_id) {
      return NextResponse.json({ error: "Missing lead_id" }, { status: 400 })
    }

    // Get lead first (capture metadata for audit log)
    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("id, full_name, email, status")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    const deleted: Record<string, number> = {
      contracts: 0,
      pending_activations: 0,
      offers: 0,
      portal_user: 0,
      leads: 0,
    }

    // 1. Get offer tokens for this lead
    const { data: offers } = await supabaseAdmin
      .from("offers")
      .select("token")
      .eq("lead_id", lead_id)

    const offerTokens = (offers ?? []).map(o => o.token)

    // 2. Delete contracts linked to those offers
    if (offerTokens.length > 0) {
      const { count } = await supabaseAdmin
        .from("contracts")
        .delete({ count: "exact" })
        .in("offer_token", offerTokens)
      deleted.contracts = count ?? 0
    }

    // 3. Delete pending_activations linked to those offers OR this lead
    if (offerTokens.length > 0) {
      const { count } = await supabaseAdmin
        .from("pending_activations")
        .delete({ count: "exact" })
        .or(`lead_id.eq.${lead_id},offer_token.in.(${offerTokens.join(",")})`)
      deleted.pending_activations = count ?? 0
    } else {
      const { count } = await supabaseAdmin
        .from("pending_activations")
        .delete({ count: "exact" })
        .eq("lead_id", lead_id)
      deleted.pending_activations = count ?? 0
    }

    // 4. Delete offers
    if (offerTokens.length > 0) {
      const { count } = await supabaseAdmin
        .from("offers")
        .delete({ count: "exact" })
        .eq("lead_id", lead_id)
      deleted.offers = count ?? 0
    }

    // 5. Delete portal user (auth.users) by email
    if (lead.email) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const match = (list?.users ?? []).find(
        (u: { email?: string }) => u.email?.toLowerCase() === lead.email.toLowerCase()
      )
      if (match) {
        const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(match.id)
        if (!deleteErr) {
          deleted.portal_user = 1
        } else {
          console.warn(`Failed to delete auth user ${match.id}: ${deleteErr.message}`)
        }
      }
    }

    // 6. Delete the lead itself
    const { error: leadErr } = await supabaseAdmin
      .from("leads")
      .delete()
      .eq("id", lead_id)

    if (leadErr) {
      return NextResponse.json(
        { error: `Failed to delete lead: ${leadErr.message}` },
        { status: 500 }
      )
    }
    deleted.leads = 1

    // Audit log
    logAction({
      actor: "crm-admin",
      action_type: "delete",
      table_name: "leads",
      record_id: lead_id,
      summary: `Cascade-deleted lead "${lead.full_name}" (${lead.email ?? "no email"})`,
      details: {
        lead_id,
        lead_name: lead.full_name,
        lead_email: lead.email,
        deleted,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Deleted ${lead.full_name} and all related data`,
      deleted,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
