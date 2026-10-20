import { NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { listOpenInvites } from "@/lib/marketing/members"

/** GET /api/marketing/team/invites — the invitations still open on my team (the link itself cannot be shown again). */
export async function GET() {
  const g = await requireMarketing("team.manage")
  if (g.res) return g.res
  return NextResponse.json({ invites: await listOpenInvites(g.ctx.team.id) }, { headers: { "Cache-Control": "no-store" } })
}
