import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp-new/create-record
 *
 * Antonio's explicit choice from the "no match found" state in an open
 * WhatsApp conversation — never automatic (Antonio, 2026-09-17: "I want the
 * option to add it if I decide"). Creates exactly the record type asked for;
 * these three are the only ones that are real, already-supported shapes in
 * this CRM (lib/mcp/tools/leads.ts::lead_create, lib/mcp/tools/operations.ts::
 * crm_create_contact) — a bare contact with no account is a normal, existing
 * pattern here, not a new concept invented for this feature.
 *
 * Body: { groupId, fullName, recordType: 'lead' | 'contact', accountId? }
 * accountId only applies to recordType 'contact' — links the new contact to
 * an existing client. Omitted → a standalone contact, matching Antonio's
 * explicit third option.
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, fullName, recordType, accountId } = await request.json() as {
    groupId?: string
    fullName?: string
    recordType?: "lead" | "contact"
    accountId?: string | null
  }

  if (!groupId || !fullName?.trim() || (recordType !== "lead" && recordType !== "contact")) {
    return NextResponse.json({ error: "groupId, fullName, and a valid recordType are required" }, { status: 400 })
  }

  const { data: group } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, external_group_id")
    .eq("id", groupId)
    .single()
  if (!group) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }
  const phone = `+${group.external_group_id.replace(/\D/g, "")}`
  const name = fullName.trim()

  try {
    if (recordType === "lead") {
      const { data: lead, error } = await supabaseAdmin
        .from("leads")
        .insert({ full_name: name, phone, source: "WhatsApp" })
        .select("id, full_name")
        .single()
      if (error) throw error

      await supabaseAdmin.from("messaging_groups").update({ lead_id: lead.id, group_name: name }).eq("id", groupId)
      return NextResponse.json({ success: true, record: { type: "lead", id: lead.id, name: lead.full_name } })
    }

    const nameParts = name.split(/\s+/)
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert, same accepted pattern as crm_create_contact (lib/mcp/tools/operations.ts); extract to lib/operations/ per dev_task fda76fd3
    const { data: contact, error } = await supabaseAdmin
      .from("contacts")
      .insert({
        full_name: name,
        first_name: nameParts[0],
        last_name: nameParts.length > 1 ? nameParts.slice(1).join(" ") : null,
        phone,
      })
      .select("id, full_name")
      .single()
    if (error) throw error

    if (accountId) {
      await supabaseAdmin.from("account_contacts").insert({ account_id: accountId, contact_id: contact.id })
    }

    await supabaseAdmin
      .from("messaging_groups")
      .update({ contact_id: contact.id, account_id: accountId || null, group_name: name })
      .eq("id", groupId)

    return NextResponse.json({ success: true, record: { type: "contact", id: contact.id, name: contact.full_name } })
  } catch (err) {
    console.error("[whatsapp-new/create-record] Error:", err)
    return NextResponse.json({ error: "Failed to create the record" }, { status: 500 })
  }
}
