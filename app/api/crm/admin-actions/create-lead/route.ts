/**
 * POST /api/crm/admin-actions/create-lead
 *
 * Admin-only endpoint to create a new lead from the CRM.
 * Checks for duplicate email/phone before creating.
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
    const body = await request.json()
    const { full_name, email, phone, source, channel, language, status, reason, referrer_name, notes } = body

    if (!full_name?.trim()) {
      return NextResponse.json({ error: "Full name is required" }, { status: 400 })
    }

    // Check for duplicate email
    if (email) {
      const { data: existing } = await supabaseAdmin
        .from("leads")
        .select("id, full_name")
        .ilike("email", email)
        .limit(1)
        .maybeSingle()

      if (existing) {
        return NextResponse.json(
          { error: `A lead with this email already exists: ${existing.full_name} (${existing.id.slice(0, 8)})` },
          { status: 409 }
        )
      }
    }

    // Check for duplicate phone
    if (phone) {
      const { data: existing } = await supabaseAdmin
        .from("leads")
        .select("id, full_name")
        .eq("phone", phone)
        .limit(1)
        .maybeSingle()

      if (existing) {
        return NextResponse.json(
          { error: `A lead with this phone already exists: ${existing.full_name} (${existing.id.slice(0, 8)})` },
          { status: 409 }
        )
      }
    }

    const { data: lead, error: insertErr } = await supabaseAdmin
      .from("leads")
      .insert({
        full_name: full_name.trim(),
        email: email || null,
        phone: phone || null,
        source: source || null,
        channel: channel || null,
        language: language || null,
        status: status || "New",
        reason: reason || null,
        referrer_name: referrer_name || null,
        notes: notes || null,
      })
      .select("id")
      .single()

    if (insertErr || !lead) {
      return NextResponse.json(
        { error: `Failed to create lead: ${insertErr?.message}` },
        { status: 500 }
      )
    }

    logAction({
      actor: "crm-admin",
      action_type: "create",
      table_name: "leads",
      record_id: lead.id,
      summary: `Lead "${full_name}" created by admin via CRM`,
      details: { lead_id: lead.id, source, channel, reason, admin_email: user?.email },
    })

    return NextResponse.json({
      ok: true,
      lead_id: lead.id,
      message: `Lead "${full_name}" created`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
