import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { normalizeMembers } from "@/lib/messaging/wabridge-groups"
import { matchMembersToCrm, phoneSearchTail, type CrmPhoneRow } from "@/lib/messaging/group-members"

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

  const members = normalizeMembers(group.members)
  if (!members) return NextResponse.json({ available: true, reported: false, groupName: group.group_name, members: [] })

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
