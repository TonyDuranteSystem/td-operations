import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { normalizeMembers } from "@/lib/messaging/wabridge-groups"
import { fillMemberNames, matchMembersToCrm, phoneSearchTail, type CrmPhoneRow } from "@/lib/messaging/group-members"
import { isJunkChatName } from "@/lib/messaging/chat-name"

export const dynamic = "force-dynamic"

/**
 * Who is in a WhatsApp group: the members the phone reported (name, number, admin), each matched to the CRM by the exact full
 * number when exactly one lead/contact holds it. Read-only. Staff only (a portal client has a login too).
 */
export async function GET(_req: Request, { params }: { params: { groupId: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  // `members` is a column added by migration 20261120-0200; until it exists the select fails — that is "not available yet", never a crash.
  const untyped = supabaseAdmin as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { members: unknown; external_group_id: string; group_name: string | null } | null; error: { message: string } | null }> } } }
  }
  const { data: group, error } = await untyped.from("messaging_groups").select("members, external_group_id, group_name").eq("id", params.groupId).maybeSingle()
  if (error) return NextResponse.json({ available: false, members: [] })
  if (!group || !group.external_group_id.endsWith("@g.us")) return NextResponse.json({ error: "Not a WhatsApp group" }, { status: 404 })

  const reported = normalizeMembers(group.members)
  if (!reported) return NextResponse.json({ available: true, reported: false, groupName: group.group_name, members: [] })

  // Names: the phone's own list first (the Mac fills it from your saved contacts); for a member it has no name for, borrow the name that
  // person used when writing in THIS group, then the name of their own chat with us. Read-only hints, never written anywhere.
  const namesInGroup = new Map<string, string>()
  const namesFromOwnChats = new Map<string, string>()
  const missing = reported.filter((m) => !m.name && m.phone).map((m) => m.phone as string)
  if (missing.length > 0) {
    try {
      const { data: rows } = await supabaseAdmin
        .from("messages")
        .select("sender_phone, sender_name")
        .eq("group_id", params.groupId)
        .eq("direction", "inbound")
        .not("sender_name", "is", null)
        .order("created_at", { ascending: false })
        .limit(500)
      for (const r of rows ?? []) {
        const d = (r.sender_phone ?? "").replace(/\D/g, "")
        if (d && r.sender_name && !namesInGroup.has(d) && !isJunkChatName(r.sender_name)) namesInGroup.set(d, r.sender_name)
      }
      const keys = missing.flatMap((d) => [d, `${d}@c.us`])
      const { data: chats } = await supabaseAdmin.from("messaging_groups").select("external_group_id, group_name").in("external_group_id", keys)
      for (const c of chats ?? []) {
        const d = c.external_group_id.replace(/\D/g, "")
        if (c.group_name && !isJunkChatName(c.group_name, c.external_group_id)) namesFromOwnChats.set(d, c.group_name)
      }
    } catch (err) {
      console.warn("[group members] name lookup failed (the list still loads):", err instanceof Error ? err.message : String(err))
    }
  }
  const members = fillMemberNames(reported, namesInGroup, namesFromOwnChats)

  // CRM names: narrow by the last 4 digits (formatted numbers keep them contiguous), confirm by the FULL number in matchMembersToCrm.
  const tails = Array.from(new Set(members.filter((m) => m.phone).map((m) => phoneSearchTail(m.phone as string))))
  let contacts: CrmPhoneRow[] = []
  let leads: CrmPhoneRow[] = []
  if (tails.length > 0) {
    try {
      const ors = (cols: string[]) => tails.flatMap((t) => cols.map((c) => `${c}.ilike.%${t}%`)).join(",")
      const [c, l] = await Promise.all([
        supabaseAdmin.from("contacts").select("id, full_name, phone, phone_2, phone_3, phone_4").or(ors(["phone", "phone_2", "phone_3", "phone_4"])).limit(1000),
        supabaseAdmin.from("leads").select("id, full_name, phone").or(ors(["phone"])).limit(1000),
      ])
      contacts = (c.data ?? []).flatMap((r) =>
        [r.phone, r.phone_2, r.phone_3, r.phone_4].map((ph) => ({ id: r.id, full_name: r.full_name, phone: ph }))
      )
      leads = (l.data ?? []).map((r) => ({ id: r.id, full_name: r.full_name, phone: r.phone }))
    } catch (err) {
      console.warn("[group members] CRM lookup failed (the list still loads):", err instanceof Error ? err.message : String(err))
    }
  }
  return NextResponse.json({ available: true, reported: true, groupName: group.group_name, members: matchMembersToCrm(members, contacts, leads) })
}
