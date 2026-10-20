import { NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { revokeInvite } from "@/lib/marketing/members"

const NO_STORE = { "Cache-Control": "no-store" }

/** DELETE /api/marketing/team/invites/[id] — cancel an open invitation on MY team (the team comes from the guard, never from the request). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const { id } = await params
  const r = await revokeInvite({
    teamId: g.ctx.team.id, inviteId: id,
    actor: { kind: g.ctx.role, userId: g.ctx.user.id, label: g.ctx.user.email ?? g.ctx.user.id, permissions: g.ctx.permissions },
  })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
