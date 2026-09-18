import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findContactByPhone } from "@/lib/messaging/contact-match"
import { jidToE164 } from "@/lib/messaging/phone"

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
    .select("external_group_id, lead_id, contact_id")
    .eq("id", groupId)
    .single()
  if (!group) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }
  if (group.lead_id || group.contact_id) {
    return NextResponse.json({ match: null, alreadyLinked: true })
  }

  const match = await findContactByPhone(jidToE164(group.external_group_id))
  return NextResponse.json({ match, alreadyLinked: false })
}
