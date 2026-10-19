import { NextRequest, NextResponse } from "next/server"
import { acceptInvite } from "@/lib/marketing/members"

/** POST /api/marketing/accept — public (the person has no login yet). Body { token, password, fullName? }. One generic answer for every failure. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await acceptInvite({ token: body.token, password: body.password, fullName: body.fullName })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: { "Cache-Control": "no-store" } })
  return NextResponse.json({ ok: true, email: r.data?.email }, { headers: { "Cache-Control": "no-store" } })
}
