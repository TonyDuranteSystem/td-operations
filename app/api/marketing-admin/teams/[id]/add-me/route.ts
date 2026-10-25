import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { addAdminAsOwner } from "@/lib/marketing/members"

/** POST /api/marketing-admin/teams/[id]/add-me — Antonio (an admin login) joins this team as its owner, so the team's workspace opens for him without "View as" and he is a person in its chat. Admin only. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const { id } = await params
  const r = await addAdminAsOwner({ teamId: id, admin: { id: user.id, email: user.email ?? null } })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true, already: r.data?.already === true }, { headers: { "Cache-Control": "no-store" } })
}
