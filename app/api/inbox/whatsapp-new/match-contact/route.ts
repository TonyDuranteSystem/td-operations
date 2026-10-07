import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findContactByPhone } from "@/lib/messaging/contact-match"
import { jidToE164 } from "@/lib/messaging/phone"
import { findNameSuggestion } from "@/lib/messaging/name-suggestion"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/whatsapp-new/match-contact?groupId=<uuid>
 *
 * Checked automatically when a WhatsApp conversation opens, so Antonio sees
 * who he's already talking to (or that no one matches) instead of guessing —
 * see docs/systems/inbox.md for the "propose, never auto-decide" rule this
 * exists to serve. Takes the conversation id rather than a raw phone number
 * so the caller (the Inbox) doesn't need to know the JID→E.164 shape itself.
 * `alreadyLinked` short-circuits the phone lookup when the conversation
 * already has a lead/contact on it (from the "new conversation" flow, or a
 * prior save) — the banner has nothing to propose in that case.
 */
export async function GET(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const groupId = request.nextUrl.searchParams.get("groupId")
  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }

  const { data: group } = await supabaseAdmin
    .from("messaging_groups")
    .select("external_group_id, group_name, lead_id, contact_id, account_id")
    .eq("id", groupId)
    .single()
  if (!group) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }
  if (group.lead_id || group.contact_id || group.account_id) {
    return NextResponse.json({ match: null, alreadyLinked: true })
  }

  const match = await findContactByPhone(jidToE164(group.external_group_id))
  if (match) return NextResponse.json({ match, alreadyLinked: false, nameSuggestion: null })

  // No client has this number. A known client may be writing from a second number: if the sender's name fits exactly one
  // existing contact, the banner offers to add this number to them (suggest only — a person clicks). Never blocks the page.
  let nameSuggestion = null
  try {
    nameSuggestion = await findNameSuggestion(groupId, group.external_group_id, group.group_name)
  } catch (err) {
    console.warn("[match-contact] name suggestion failed:", err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ match: null, alreadyLinked: false, nameSuggestion })
}
