import { NextRequest, NextResponse } from "next/server"
import { completeReset } from "@/lib/marketing/password-reset"

const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing/reset — public (the person has no working password). Body { token, password }. One generic answer for every failure of the link. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await completeReset({ token: body.token, password: body.password })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, email: r.data?.email }, { headers: NO_STORE })
}
