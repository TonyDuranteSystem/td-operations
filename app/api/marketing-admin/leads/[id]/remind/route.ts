import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { adminMemberContext } from "@/lib/marketing/guard"
import { getLeadAny } from "@/lib/marketing/admin-leads"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { myThread, openDm, sendThreadMessage } from "@/lib/marketing/team-chat-server"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE })

/**
 * POST /api/marketing-admin/leads/[id]/remind — body { message }. Antonio reminds the person who has a lead (an unpaid payment link, say) with a PRIVATE direct message in the team chat: the setter never sees it.
 * He must have joined the lead's team (his message is sent under his own name). Admin only (strict check), JSON only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return fail("Not allowed.", 403)
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail("Send JSON.", 415)
  const message = ((await req.json().catch(() => ({}))) as { message?: unknown }).message
  if (typeof message !== "string" || !message.trim()) return fail("Write the reminder first.", 400)
  const me = await adminMemberContext({ id: user.id, email: user.email })
  if (me.ok === false) return fail("Join the team first (CRM > Marketing > Teams), then you can write to its people.", 409)
  const { id } = await params
  const lead = await getLeadAny(leadDb(), id)
  if (!lead || lead.team_id !== me.ctx.team.id) return fail("Lead not found in your team.", 404)
  const owner = (lead as { claimed_by?: string | null }).claimed_by
  if (!owner) return fail("Nobody has this lead yet, so there is nobody to remind. Give it to a person first.", 409)
  const dm = await openDm(me.ctx, owner)
  if (dm.ok === false) return fail(dm.error, dm.status)
  const thread = await myThread(me.ctx, dm.threadId)
  if (!thread) return fail("Could not open the chat. Please try again.", 500)
  const sent = await sendThreadMessage(me.ctx, thread, { message })
  if (sent.ok === false) return fail(sent.error, sent.status)
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
