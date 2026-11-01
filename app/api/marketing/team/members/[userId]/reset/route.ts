import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { createOwnerReset } from "@/lib/marketing/password-reset"
import type { Actor } from "@/lib/marketing/members"

const NO_STORE = { "Cache-Control": "no-store" }
const actorOf = (ctx: { role: "owner" | "member"; admin?: true; user: { id: string; email: string | null }; permissions: string[] }): Actor =>
  ({ kind: ctx.admin ? "admin" : ctx.role, userId: ctx.user.id, label: ctx.user.email ?? ctx.user.id, permissions: ctx.permissions })

/**
 * POST /api/marketing/team/members/[userId]/reset — a person who manages the team makes a one-time link that lets a member of HIS team choose a new password. The link is returned once (it is never stored,
 * only its hash is) and the manager sends it himself. Only Antonio can make one for a team owner. The team is the caller's own (from the guard).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  const { userId } = await params
  const r = await createOwnerReset({ teamId: g.ctx.team.id, userId, actor: actorOf(g.ctx) })
  if (r.ok === false || !r.data) return NextResponse.json({ error: r.error ?? "Something went wrong. Please try again." }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, ...r.data }, { headers: NO_STORE })
}
