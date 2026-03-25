/**
 * POST /api/crm/admin-actions/mark-lost
 *
 * Admin-only endpoint to mark a lead as Lost with a reason.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin } from "@/lib/auth"
import { logAction } from "@/lib/mcp/action-log"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { lead_id, reason } = await request.json()

    if (!lead_id || !reason?.trim()) {
      return NextResponse.json(
        { error: "Missing required fields: lead_id, reason" },
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

    if (lead.status === "Converted") {
      return NextResponse.json({ error: "Cannot mark a converted lead as lost" }, { status: 409 })
    }

    await supabaseAdmin
      .from("leads")
      .update({
        status: "Lost",
        notes: `[${new Date().toISOString().split("T")[0]}] Marked as Lost: ${reason.trim()}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id)

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: lead_id,
      summary: `Lead "${lead.full_name}" marked as Lost. Reason: ${reason}`,
      details: { lead_id, reason, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true, message: `${lead.full_name} marked as Lost` })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
