/**
 * POST /api/crm/admin-actions/update-lead-status
 *
 * Admin-only endpoint for simple lead status updates (e.g., kanban drag).
 * Does NOT handle Converted or Lost — those have dedicated endpoints.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin } from "@/lib/auth"
import { logAction } from "@/lib/mcp/action-log"

const ALLOWED_STATUSES = [
  "New",
  "Call Scheduled",
  "Call Done",
  "Contacted",
  "Qualified",
  "Offer Sent",
  "Negotiating",
  "Suspended",
]

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { lead_id, status } = await request.json()

    if (!lead_id || !status) {
      return NextResponse.json({ error: "Missing lead_id or status" }, { status: 400 })
    }

    if (!ALLOWED_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `Status "${status}" not allowed. Use dedicated endpoints for Converted/Lost.` },
        { status: 400 }
      )
    }

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("full_name, status")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    const previousStatus = lead.status

    await supabaseAdmin
      .from("leads")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", lead_id)

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: lead_id,
      summary: `Lead "${lead.full_name}" status: ${previousStatus} → ${status}`,
      details: { lead_id, previous_status: previousStatus, new_status: status, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
