import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { createTeam, listTeams } from "@/lib/marketing/settings"

const NO_STORE = { "Cache-Control": "no-store" }
async function adminOnly() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isSecureAdmin(user) ? user : null
}

/** GET /api/marketing-admin/teams — every team (Antonio only; a staff route, so marketing logins are turned away at the door). */
export async function GET() {
  if (!(await adminOnly())) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  return NextResponse.json({ teams: await listTeams() }, { headers: NO_STORE })
}

/** POST — create a team in 'draft' (nobody can log in until Antonio switches it on). Body { name }. */
export async function POST(req: NextRequest) {
  const user = await adminOnly()
  if (!user) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const body = await req.json().catch(() => ({}))
  const r = await createTeam({ name: body.name, actor: user.email ?? user.id })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json(r.data, { headers: NO_STORE })
}
