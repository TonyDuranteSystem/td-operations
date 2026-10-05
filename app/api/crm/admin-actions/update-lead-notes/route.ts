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
import { updateLeadColumnGuarded, hasExpectedValue, isGuardedFailure, type LeadDb } from "@/lib/leads/guarded-update"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { lead_id, notes } = body

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

    // Guarded write: the notes are overwritten WHOLE, so two people editing the same lead's
    // notes used to lose one person's writing silently. `expected_notes` is the text the
    // caller was editing from; a mismatch now returns 409 instead of overwriting.
    const guarded = await updateLeadColumnGuarded(supabaseAdmin as unknown as LeadDb, {
      leadId: lead_id,
      column: "notes",
      newValue: notes ?? "",
      expected: body.expected_notes,
      hasExpected: hasExpectedValue(body, "expected_notes"),
    })
    if (isGuardedFailure(guarded)) {
      if (guarded.reason === "conflict") {
        return NextResponse.json(
          { error: guarded.message, conflict: true, current_value: guarded.currentValue },
          { status: 409 }
        )
      }
      if (guarded.reason === "not_found") {
        return NextResponse.json({ error: guarded.message }, { status: 404 })
      }
      return NextResponse.json({ error: guarded.message }, { status: 500 })
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
