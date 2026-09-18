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
 *
 * Body (attach mode): { groupId, existingContactId } — attaches the WhatsApp
 * number to a PERSON WHO ALREADY EXISTS at the picked account instead of
 * creating a new one. Added 2026-09-18 (dev job f331cd43) after "Contact of
 * an existing client" silently created a duplicate Marinela Marku: the flow
 * could find the right company but had no way to say "it's HER, not a new
 * person." Fills the contact's phone only if it is currently null — never
 * overwrites a real number already on file.
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, fullName, recordType, accountId, existingContactId } = await request.json() as {
    groupId?: string
    fullName?: string
    recordType?: "lead" | "contact"
    accountId?: string | null
    existingContactId?: string
  }

  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
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

  if (existingContactId) {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, phone")
      .eq("id", existingContactId)
      .single()
    if (fetchError || !existing) {
      return NextResponse.json({ error: "That contact could not be found" }, { status: 404 })
    }

    if (!existing.phone) {
      // eslint-disable-next-line no-restricted-syntax -- same accepted pre-P2.4 pattern as the contacts.insert below in this file, extract to lib/operations/ per dev_task fda76fd3
      await supabaseAdmin.from("contacts").update({ phone }).eq("id", existingContactId)
    }

    await supabaseAdmin
      .from("messaging_groups")
      .update({ contact_id: existingContactId, account_id: accountId || null, group_name: existing.full_name })
      .eq("id", groupId)

    return NextResponse.json({ success: true, record: { type: "contact", id: existingContactId, name: existing.full_name } })
  }

  if (!fullName?.trim() || (recordType !== "lead" && recordType !== "contact")) {
    return NextResponse.json({ error: "groupId, fullName, and a valid recordType are required" }, { status: 400 })
  }
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
