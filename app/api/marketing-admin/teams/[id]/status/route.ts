import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { setTeamStatus } from "@/lib/marketing/settings"
import { isTeamStatus } from "@/lib/marketing/team-status"

/** PATCH /api/marketing-admin/teams/[id]/status — the KILL SWITCH and the activation: Antonio only. Body { status: 'active' | 'paused' }. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  if (!isTeamStatus(body.status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 })
  const r = await setTeamStatus(id, body.status, user.email ?? user.id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json(r.data)
}
