import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { createOwnerReset } from "@/lib/marketing/password-reset"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/teams/[id]/members/[userId]/reset — Antonio (an admin login) makes a one-time link that lets a person on this team choose a new password, from the admin Teams page.
 * Same rules as the team workspace's own button (one function, createOwnerReset): never his own login, never someone paused or off the team, never a login that is not a marketing login; being
 * the admin is what allows it for a team owner such as Rocco. The link is returned once (only its hash is stored); Antonio sends it himself.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const { id, userId } = await params
  const r = await createOwnerReset({ teamId: id, userId, actor: { kind: "admin", userId: user.id, label: user.email ?? user.id, permissions: [] } })
  if (r.ok === false || !r.data) return NextResponse.json({ error: r.error ?? "Something went wrong. Please try again." }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, ...r.data }, { headers: NO_STORE })
}
