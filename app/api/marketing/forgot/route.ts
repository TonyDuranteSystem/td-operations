import { NextRequest, NextResponse } from "next/server"
import { requestForgotPassword } from "@/lib/marketing/password-reset"
import { FORGOT_ANSWER } from "@/lib/marketing/reset-rules"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/forgot — public (the person cannot sign in). Body { email, lang? }. A real-looking address always gets the same answer, whether or not it belongs to a marketing login;
 * only a team member's own marketing login ever gets an email, and only at its own address.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await requestForgotPassword({ email: body.email, lang: body.lang })
  if (!r.valid) return NextResponse.json({ error: "That email address does not look right." }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, message: FORGOT_ANSWER }, { headers: NO_STORE })
}
