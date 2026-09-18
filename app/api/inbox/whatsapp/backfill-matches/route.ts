import { NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { digitsOnly } from "@/lib/messaging/phone"
import { classifyGroups, type MatchCandidate, type GroupToMatch } from "@/lib/messaging/backfill-matches"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/backfill-matches
 *
 * Antonio, 2026-09-18: "can now the system read all chats and check if the
 * current numbers belongs to active client and save them and update their
 * profile" — a one-shot, staff-triggered sweep of every unlinked WhatsApp
 * conversation, not a background job (nothing here runs unless a staff
 * member presses the button). A confident (single exact-number) match is
 * linked immediately — the same "fill phone only if blank, never overwrite"
 * rule as attaching one conversation manually. An ambiguous match (the
 * exact same number really does exist on 2+ CRM records) is left alone and
 * returned for a human to pick — see /api/inbox/whatsapp-new/create-record's
 * existingContactId/existingLeadId branches for the resolve step.
 */
export async function POST() {
  const denied = await requireStaffRoute()
  if (denied) return denied

  // Same two-step channel-id-then-groups shape as /api/inbox/whatsapp/conversations —
  // supabase-js filtering on a joined table's column is unreliable here.
  const { data: channelRows, error: channelErr } = await supabaseAdmin
    .from("messaging_channels")
    .select("id")
    .eq("platform", "whatsapp")
  if (channelErr) return NextResponse.json({ error: channelErr.message }, { status: 500 })
  const channelIds = (channelRows ?? []).map((c) => c.id)
  if (!channelIds.length) return NextResponse.json({ linked: [], ambiguous: [] })

  const { data: groupRows, error: groupErr } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, group_name, external_group_id")
    .in("channel_id", channelIds)
    .is("contact_id", null)
    .is("lead_id", null)
  if (groupErr) return NextResponse.json({ error: groupErr.message }, { status: 500 })

  const groups: GroupToMatch[] = (groupRows ?? []).map((g) => ({
    groupId: g.id as string,
    digits: digitsOnly(g.external_group_id as string),
  }))
  if (groups.length === 0) {
    return NextResponse.json({ linked: [], ambiguous: [] })
  }

  // No phone-not-null filter here — classifyGroups already skips a candidate with
  // no phone or a too-short one, and this route runs on demand, not on a hot path.
  const [{ data: leadRows, error: leadErr }, { data: contactRows, error: contactErr }] = await Promise.all([
    supabaseAdmin.from("leads").select("id, full_name, phone"),
    supabaseAdmin.from("contacts").select("id, full_name, phone, phone_2"),
  ])
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 })
  if (contactErr) return NextResponse.json({ error: contactErr.message }, { status: 500 })

  const candidates: MatchCandidate[] = [
    ...(leadRows ?? []).map((l) => ({ type: "lead" as const, id: l.id as string, name: l.full_name as string, phone: l.phone as string | null })),
    ...(contactRows ?? []).flatMap((c) => {
      const rows: MatchCandidate[] = []
      if (c.phone) rows.push({ type: "contact", id: c.id as string, name: c.full_name as string, phone: c.phone as string })
      // A second number on the same contact is still "this contact" — dedupe by id downstream isn't needed since
      // classifyGroups groups by DIGITS, and the two numbers are (by construction) different digit strings.
      if (c.phone_2 && c.phone_2 !== c.phone) rows.push({ type: "contact", id: c.id as string, name: c.full_name as string, phone: c.phone_2 as string })
      return rows
    }),
  ]

  const classified = classifyGroups(groups, candidates)
  const nameById = new Map((groupRows ?? []).map((g) => [g.id as string, g.group_name as string | null]))

  const linked: Array<{ groupId: string; previousName: string | null; matchedName: string; matchedType: "lead" | "contact" }> = []
  const ambiguous: Array<{ groupId: string; previousName: string | null; candidates: MatchCandidate[] }> = []

  for (const { groupId, candidates: cands } of classified) {
    if (cands.length === 0) continue
    if (cands.length > 1) {
      ambiguous.push({ groupId, previousName: nameById.get(groupId) ?? null, candidates: cands })
      continue
    }
    const match = cands[0]
    const update: Record<string, unknown> = { group_name: match.name }
    if (match.type === "lead") update.lead_id = match.id
    else update.contact_id = match.id
    const { error: updateErr } = await supabaseAdmin.from("messaging_groups").update(update).eq("id", groupId)
    if (updateErr) {
      console.error("[whatsapp/backfill-matches] failed to link", groupId, updateErr.message)
      continue
    }
    if (match.type === "contact") {
      const { data: existing } = await supabaseAdmin.from("contacts").select("phone").eq("id", match.id).single()
      // Confident match already means this contact's OWN number equals the WhatsApp number — filling
      // it in only helps a contact matched via phone_2 whose primary phone is still blank.
      if (existing && !existing.phone) {
        // eslint-disable-next-line no-restricted-syntax -- same accepted pattern as the sibling attach-existing-contact branch in create-record/route.ts, extract to lib/operations/ per dev_task fda76fd3
        await supabaseAdmin.from("contacts").update({ phone: match.phone }).eq("id", match.id)
      }
    }
    linked.push({ groupId, previousName: nameById.get(groupId) ?? null, matchedName: match.name, matchedType: match.type })
  }

  return NextResponse.json({ linked, ambiguous })
}
