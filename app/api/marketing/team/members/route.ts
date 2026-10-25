import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { createInvite, listMembers, type Actor } from "@/lib/marketing/members"

const NO_STORE = { "Cache-Control": "no-store" }
const actorOf = (ctx: { role: "owner" | "member"; admin?: true; user: { id: string; email: string | null }; permissions: string[] }): Actor =>
  ({ kind: ctx.admin ? "admin" : ctx.role, userId: ctx.user.id, label: ctx.user.email ?? ctx.user.id, permissions: ctx.permissions })

/** GET /api/marketing/team/members — the people on my team (owner, or a member who may manage the team). */
export async function GET() {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  return NextResponse.json({ members: await listMembers(g.ctx.team.id) }, { headers: NO_STORE })
}

/** POST /api/marketing/team/members — invite a person. Body: { email, bundle, permissions? }. The team comes from the guard, never from the request. */
export async function POST(req: NextRequest) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const body = await req.json().catch(() => ({}))
  const r = await createInvite({ teamId: g.ctx.team.id, email: body.email, memberRole: "member", bundle: body.bundle ?? null, permissions: Array.isArray(body.permissions) ? body.permissions : [], actor: actorOf(g.ctx) })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json(r.data, { headers: NO_STORE })
}
