import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { getMarketingSetting, getTeam } from "@/lib/marketing/settings"
import { VIEW_AS_COOKIE, VIEW_AS_MAX_AGE_SECONDS, serializeViewAs } from "@/lib/marketing/view-as"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

const body = z.object({ teamId: z.string().uuid(), as: z.string().trim().min(1).max(80) })

async function admin() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isSecureAdmin(user) ? user : null
}

/** POST /api/marketing-admin/view-as — Antonio picks a team and "owner" or a bundle key; sets the short-lived cookie the guard reads. Strict admin, JSON only. */
export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Pick a team and a role." }, { status: 400, headers: NO_STORE })
  const { teamId, as } = parsed.data
  if (!(await getTeam(teamId))) return NextResponse.json({ error: "Pick a team." }, { status: 400, headers: NO_STORE })
  if (as !== "owner") {
    const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(bundles, as)) return NextResponse.json({ error: "That role does not exist for this team." }, { status: 400, headers: NO_STORE })
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE })
  res.cookies.set(VIEW_AS_COOKIE, serializeViewAs({ teamId, as: as === "owner" ? "owner" : { bundle: as } }), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: VIEW_AS_MAX_AGE_SECONDS,
  })
  return res
}

/** DELETE /api/marketing-admin/view-as — stop viewing as someone else. */
export async function DELETE() {
  if (!(await admin())) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE })
  res.cookies.set(VIEW_AS_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 })
  return res
}
