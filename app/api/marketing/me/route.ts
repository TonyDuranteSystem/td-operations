import { NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"

/** GET /api/marketing/me — who am I in the marketing workspace (the guard's own answer). */
export async function GET() {
  const g = await requireMarketing()
  if (g.res) return g.res
  const { ctx } = g
  return NextResponse.json(
    { user: ctx.user, team: { id: ctx.team.id, name: ctx.team.name, status: ctx.team.status }, role: ctx.role, permissions: ctx.permissions },
    { headers: { "Cache-Control": "no-store" } },
  )
}
