/**
 * POST /api/crm/admin-actions/update-lead-notes
 *
 * Admin/team endpoint to update a lead's notes field.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const { lead_id, notes } = await request.json()

    if (!lead_id) {
      return NextResponse.json({ error: "Missing lead_id" }, { status: 400 })
    }

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("full_name")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    const { error } = await supabaseAdmin
      .from("leads")
      .update({ notes: notes ?? "", updated_at: new Date().toISOString() })
      .eq("id", lead_id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: lead_id,
      summary: `Updated notes for lead "${lead.full_name}"`,
      details: { lead_id, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
