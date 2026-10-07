import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { jidToE164 } from "@/lib/messaging/phone"
import { isOneToOneNumberKey, phoneSlotPlan, CONTACT_PHONE_SLOTS, type ContactPhoneSlot } from "@/lib/messaging/name-match"
import { findNameSuggestion } from "@/lib/messaging/name-suggestion"

export const dynamic = "force-dynamic"

const digitsOf = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "")

/**
 * POST /api/inbox/whatsapp-new/add-number   { groupId, contactId }
 *
 * Staff clicked "Add this number" on the same-name suggestion (Antonio, 2026-10-07): put this WhatsApp number on the
 * existing contact (first free of its four phone slots) and link the chat to them. Nothing here is automatic, and the
 * server re-decides everything the banner implied — a stale, forged or raced call cannot put a number on the wrong person:
 *  - the chat must be a real 1:1 number chat and still unlinked;
 *  - the SAME exactly-one-match rule as the banner must still pick THIS contact (a second same-name client appearing
 *    since the banner loaded, or a different contactId, is refused);
 *  - the number must not already belong to any OTHER contact or lead (formatted numbers included);
 *  - every lookup fails closed: a database error is never read as "no clash".
 * Order: LINK the chat first (guarded), THEN write the number into a free slot (guarded), and undo the link if the number
 * cannot be saved — so a refused or failed call never leaves a number on a contact whose chat went elsewhere.
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, contactId } = (await request.json().catch(() => ({}))) as { groupId?: string; contactId?: string }
  if (!groupId || !contactId) return NextResponse.json({ error: "groupId and contactId are required" }, { status: 400 })

  const { data: group } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, external_group_id, group_name, lead_id, contact_id, account_id")
    .eq("id", groupId)
    .single()
  if (!group) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  if (group.lead_id || group.contact_id || group.account_id) {
    return NextResponse.json({ error: "This chat is already linked to someone — reload the page." }, { status: 409 })
  }
  if (!isOneToOneNumberKey(group.external_group_id)) {
    return NextResponse.json({ error: "Only a one-to-one chat with a phone number can be matched to a client." }, { status: 400 })
  }
  const e164 = jidToE164(group.external_group_id)
  const digits = digitsOf(e164)

  // The same decision the banner made — and it must still be exactly this one client.
  let suggestion
  try {
    suggestion = await findNameSuggestion(groupId, group.external_group_id, group.group_name)
  } catch (err) {
    console.error("[whatsapp-new/add-number] suggestion check failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Could not double-check the match — nothing was changed. Please try again." }, { status: 500 })
  }
  if (!suggestion || suggestion.kind !== "one" || suggestion.contact.id !== contactId) {
    return NextResponse.json({ error: "This is no longer a single clear match, so nothing was changed." }, { status: 409 })
  }

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, phone, phone_2, phone_3, phone_4, merged_into, is_test")
    .eq("id", contactId)
    .single()
  if (!contact || contact.merged_into || contact.is_test) {
    return NextResponse.json({ error: "That client could not be found." }, { status: 404 })
  }

  // The number must not already belong to a DIFFERENT contact or any lead. Numbers are stored in mixed formats
  // ("(305) 555-1234"), so prefilter on the last 4 digits (contiguous in practice) and confirm on full digits in code.
  const last4 = `%${digits.slice(-4)}%`
  const [contactsRes, leadsRes] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select("id, phone, phone_2, phone_3, phone_4")
      .neq("id", contactId)
      .is("merged_into", null)
      .or(`phone.ilike.${last4},phone_2.ilike.${last4},phone_3.ilike.${last4},phone_4.ilike.${last4}`)
      .limit(500),
    supabaseAdmin.from("leads").select("id, phone").ilike("phone", last4).limit(500),
  ])
  if (contactsRes.error || leadsRes.error) {
    console.error("[whatsapp-new/add-number] number-clash lookup failed:", contactsRes.error?.message ?? leadsRes.error?.message)
    return NextResponse.json({ error: "Could not check whether someone else has this number — nothing was changed." }, { status: 500 })
  }
  const heldByContact = (contactsRes.data ?? []).some((o) =>
    ([o.phone, o.phone_2, o.phone_3, o.phone_4] as Array<string | null>).some((p) => digitsOf(p) === digits),
  )
  const heldByLead = (leadsRes.data ?? []).some((l) => digitsOf(l.phone) === digits)
  if (heldByContact || heldByLead) {
    return NextResponse.json({ error: "Another client or lead already has this number — nothing was changed." }, { status: 409 })
  }

  const plan = phoneSlotPlan(contact as Partial<Record<ContactPhoneSlot, string | null>>, digits)
  if (plan.kind === "full") {
    return NextResponse.json({ error: "This client already has four phone numbers on file. Remove one first." }, { status: 409 })
  }

  // 1) Link the chat — guarded, so a chat linked in the meantime is never overwritten.
  const { data: linked, error: linkError } = await supabaseAdmin
    .from("messaging_groups")
    .update({ contact_id: contactId, updated_at: new Date().toISOString() })
    .eq("id", groupId)
    .is("contact_id", null)
    .is("lead_id", null)
    .is("account_id", null)
    .select("id")
  if (linkError) {
    console.error("[whatsapp-new/add-number] link failed:", linkError.message)
    return NextResponse.json({ error: "Could not link the chat — nothing was changed." }, { status: 500 })
  }
  if (!linked?.length) {
    // Someone (or the every-minute auto-linker) got there first. Fine only if it linked THIS client.
    const { data: now } = await supabaseAdmin.from("messaging_groups").select("contact_id").eq("id", groupId).single()
    if (now?.contact_id !== contactId) {
      return NextResponse.json({ error: "This chat was linked to someone else a moment ago — nothing was changed." }, { status: 409 })
    }
  }

  // 2) Save the number in a free slot — guarded so two clicks cannot take the same slot (the second tries the next free one).
  let saved = plan.kind === "already"
  if (plan.kind === "slot") {
    let current = contact as Partial<Record<ContactPhoneSlot, string | null>>
    for (let attempt = 0; attempt < CONTACT_PHONE_SLOTS.length && !saved; attempt++) {
      const p = phoneSlotPlan(current, digits)
      if (p.kind === "already") { saved = true; break }
      if (p.kind === "full") break
      // eslint-disable-next-line no-restricted-syntax -- same accepted pre-P2.4 raw contacts write as whatsapp-new/create-record; extract to lib/operations/ per dev_task fda76fd3
      const { data: wrote, error } = await supabaseAdmin
        .from("contacts")
        .update({ [p.slot]: e164 })
        .eq("id", contactId)
        .or(`${p.slot}.is.null,${p.slot}.eq.`)
        .select("id")
      if (error) break
      if (wrote?.length) { saved = true; break }
      // The slot was taken in the meantime: re-read and try the next free one.
      const { data: fresh } = await supabaseAdmin
        .from("contacts")
        .select("phone, phone_2, phone_3, phone_4")
        .eq("id", contactId)
        .single()
      if (!fresh) break
      current = fresh as Partial<Record<ContactPhoneSlot, string | null>>
    }
  }
  if (!saved) {
    // Undo the link so no chat points at a client whose file does not carry this number.
    await supabaseAdmin
      .from("messaging_groups")
      .update({ contact_id: null, updated_at: new Date().toISOString() })
      .eq("id", groupId)
      .eq("contact_id", contactId)
    return NextResponse.json({ error: "Could not save the number on this client — nothing was changed." }, { status: 409 })
  }

  return NextResponse.json({
    success: true,
    record: { type: "contact", id: contactId, name: contact.full_name },
    numberAdded: plan.kind === "slot",
  })
}
