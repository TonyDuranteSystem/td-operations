import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { permissionFor } from "@/lib/marketing/lead-actions"
import { applyLeadAction, loadActionSettings, parseLeadAction } from "@/lib/marketing/lead-actions-server"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { chatMembers } from "@/lib/marketing/lead-chat-server"
import { sendMarketingPush } from "@/lib/marketing/push"
import { rescheduleRecipients, reschedulePush } from "@/lib/marketing/calendar-notify"
import { personName } from "@/lib/marketing/setter-note"

const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing/leads/[id]/action — pick / give back / note / Good / Not in target / Call back later. The team comes from the guard, never from the request. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing()
  if (g.res) return g.res
  const parsed = parseLeadAction(await req.json().catch(() => null))
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  if (!hasPermission(g.ctx.permissions, permissionFor(parsed.value.action))) {
    return NextResponse.json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, { status: 403, headers: NO_STORE })
  }
  const { id } = await params
  const settings = await loadActionSettings(g.ctx.team.id)
  const r = await applyLeadAction(leadDb(), g.ctx.team.id, id, parsed.value, { id: g.ctx.user.id, email: g.ctx.user.email, role: g.ctx.role }, settings, new Date(), g.ctx.viewAs !== undefined)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  if (parsed.value.action === "reschedule" && g.ctx.viewAs === undefined) await notifyMoved(g.ctx.team.id, g.ctx.user.id, g.ctx.user.email, id, parsed.value)
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}

/** Tell the seller and the setter that a call was moved. The move is already saved: a failed or slow notification never fails it (and never holds the answer back more than a few seconds). */
async function notifyMoved(teamId: string, moverId: string, moverEmail: string | null, leadId: string, a: { at: string; reason: string; from?: string | null }) {
  try {
    const [{ data: lead }, members] = await Promise.all([
      leadDb().from("marketing_leads").select("full_name, email").eq("id", leadId).eq("team_id", teamId).maybeSingle(),
      chatMembers(teamId),
    ])
    const to = rescheduleRecipients(members.map(m => ({ user_id: m.id, status: m.status, permissions: m.permissions })), moverId)
    if (to.length === 0) return
    // a lead with no name is shown by its email, never its phone number (a notification can sit on a lock screen)
    const text = reschedulePush({ moverName: personName(moverEmail ?? ""), leadName: lead?.full_name || lead?.email || "Lead", from: a.from ?? null, to: new Date(a.at).toISOString(), reason: a.reason })
    await Promise.race([
      sendMarketingPush(teamId, to, { ...text, url: `/marketing/board?open=${leadId}`, tag: `moved-${leadId}` }),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
  } catch { /* the call is already moved */ }
}
