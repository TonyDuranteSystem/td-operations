/**
 * POST /api/crm/admin-actions/convert-lead
 *
 * Admin-only endpoint to convert a lead to a contact WITHOUT payment.
 * Used for: exceptions, legacy migration, leads that paid outside system.
 *
 * This endpoint:
 *   a. Creates Contact from lead data
 *   b. Sets lead.status → Converted
 *   c. Optionally creates portal login (tier: onboarding)
 *   d. Does NOT create payment, does NOT trigger activate-service
 *   e. Logs everything to action_log
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin } from "@/lib/auth"
import { logAction } from "@/lib/mcp/action-log"

interface ConvertLeadBody {
  lead_id: string
  reason: string
  create_portal_login?: boolean
}

export async function POST(request: Request) {
  // Auth check — admin only
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body: ConvertLeadBody = await request.json()
    const { lead_id, reason, create_portal_login } = body

    if (!lead_id || !reason?.trim()) {
      return NextResponse.json(
        { error: "Missing required fields: lead_id, reason" },
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

    // 2. Check if contact already exists
    let contactId: string | null = null
    let contactCreated = false

    if (lead.email) {
      const { data: existingContact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .ilike("email", lead.email)
        .limit(1)
        .maybeSingle()

      if (existingContact) {
        contactId = existingContact.id
      }
    }

    // 3. Create contact if doesn't exist
    if (!contactId) {
      const { data: newContact, error: contactErr } = await supabaseAdmin
        .from("contacts")
        .insert({
          full_name: lead.full_name,
          email: lead.email,
          phone: lead.phone,
          language: lead.language === "Italian" ? "it" : "en",
          role: "Owner",
          is_test: lead.is_test || false,
        })
        .select("id")
        .single()

      if (contactErr || !newContact) {
        return NextResponse.json(
          { error: `Failed to create contact: ${contactErr?.message}` },
          { status: 500 }
        )
      }
      contactId = newContact.id
      contactCreated = true
    }

    // 4. Update lead status
    await supabaseAdmin
      .from("leads")
      .update({
        status: "Converted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id)

    // 5. Log to action_log
    logAction({
      actor: "crm-admin",
      action_type: "convert_lead",
      table_name: "leads",
      record_id: lead_id,
      summary: `Lead "${lead.full_name}" converted to contact by admin. Reason: ${reason}`,
      details: {
        lead_id,
        contact_id: contactId,
        contact_created: contactCreated,
        reason,
        create_portal_login,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Lead "${lead.full_name}" converted to contact.`,
      contact_id: contactId,
      contact_created: contactCreated,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[convert-lead] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
