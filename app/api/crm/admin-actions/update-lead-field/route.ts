/**
 * POST /api/crm/admin-actions/update-lead-field
 *
 * Generic endpoint to update a single lead field.
 * Only allows whitelisted fields to prevent arbitrary writes.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

const ALLOWED_FIELDS = [
  "full_name",
  "email",
  "phone",
  "language",
  "source",
  "referrer_name",
  "call_date",
  "call_notes",
]

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const { lead_id, field, value } = await request.json()

    if (!lead_id || !field) {
      return NextResponse.json({ error: "Missing lead_id or field" }, { status: 400 })
    }

    if (!ALLOWED_FIELDS.includes(field)) {
      return NextResponse.json({ error: `Field '${field}' is not editable` }, { status: 400 })
    }

    // Validate specific fields
    if (field === "full_name" && (!value || !value.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
    }

    if (field === "email" && value) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(value.trim())) {
        return NextResponse.json({ error: "Invalid email format" }, { status: 400 })
      }
    }

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("full_name")
      .eq("id", lead_id)
      .single()

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    }

    // Normalize value: empty string → null for nullable fields
    const normalizedValue = (value === "" || value === undefined) ? null : value.trim()

    const { error } = await supabaseAdmin
      .from("leads")
      .update({ [field]: normalizedValue, updated_at: new Date().toISOString() })
      .eq("id", lead_id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "leads",
      record_id: lead_id,
      summary: `Updated ${field} for lead "${lead.full_name}"`,
      details: { lead_id, field, new_value: normalizedValue, admin_email: user?.email },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
