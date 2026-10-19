import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { createInvite } from "@/lib/marketing/members"

/** POST /api/marketing-admin/teams/[id]/owner-invite — Antonio invites the team OWNER (Rocco). Body { email }. Returns the one-time link. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const r = await createInvite({ teamId: id, email: body.email, memberRole: "owner", actor: { kind: "admin", userId: user.id, label: user.email ?? user.id, permissions: [] } })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json(r.data, { headers: { "Cache-Control": "no-store" } })
}
