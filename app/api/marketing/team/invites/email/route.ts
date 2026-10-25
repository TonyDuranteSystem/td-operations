import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { previewInviteEmail, sendInviteEmail } from "@/lib/marketing/invite-email-server"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/team/invites/email — body { token, send?: boolean }. A person who may manage the team previews (default) or sends the invitation email of an invitation of HIS OWN team.
 * An owner's invitation is never emailed from here (only Antonio makes those, from the CRM).
 */
export async function POST(req: NextRequest) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const body = await req.json().catch(() => ({}))
  const scope = { teamId: g.ctx.team.id, allowOwnerInvite: !!g.ctx.admin, actorLabel: g.ctx.user.email ?? g.ctx.user.id }
  const r = body.send === true ? await sendInviteEmail(body.token, scope, body.lang) : await previewInviteEmail(body.token, scope, body.lang)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, ...r.data }, { headers: NO_STORE })
}
