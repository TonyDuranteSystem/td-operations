import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { removeMember, setMemberPaused, updateMemberAccess, type Actor } from "@/lib/marketing/members"

const NO_STORE = { "Cache-Control": "no-store" }
const actorOf = (ctx: { role: "owner" | "member"; user: { id: string; email: string | null }; permissions: string[] }): Actor =>
  ({ kind: ctx.role, userId: ctx.user.id, label: ctx.user.email ?? ctx.user.id, permissions: ctx.permissions })

/** PATCH — body { action: 'pause' | 'resume' | 'access', bundle?, permissions? }. The team is the caller's own (from the guard). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const { userId } = await params
  const body = await req.json().catch(() => ({}))
  const actor = actorOf(g.ctx)
  const r =
    body.action === "pause" ? await setMemberPaused({ teamId: g.ctx.team.id, userId, paused: true, actor })
    : body.action === "resume" ? await setMemberPaused({ teamId: g.ctx.team.id, userId, paused: false, actor })
    : body.action === "access" ? await updateMemberAccess({ teamId: g.ctx.team.id, userId, bundle: body.bundle, permissions: body.permissions, actor })
    : { ok: false, error: "Unknown action." }
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}

/** DELETE — remove a person: the login is ended at once. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const { userId } = await params
  const r = await removeMember({ teamId: g.ctx.team.id, userId, actor: actorOf(g.ctx) })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
