import { NextRequest, NextResponse } from "next/server"
import { requestForgotPassword } from "@/lib/marketing/password-reset"
import { FORGOT_ANSWER, FORGOT_MAX_PER_MINUTE, TOO_MANY_ATTEMPTS_ERROR, bodyObject } from "@/lib/marketing/reset-rules"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/forgot — public (the person cannot sign in). Body { email, lang? }. A real-looking address always gets the same answer, whether or not it belongs to a marketing login;
 * only a team member's own marketing login ever gets an email, and only at its own address.
 * Every request from one place is counted, matched or not, so a "too many" answer reveals nothing. KNOWN LIMIT, same as the portal's reset page: the counter lives in one server instance's memory, so it
 * is a speed bump, not a guarantee; the real caps are the three-an-hour limit per login and the single open link.
 */
export async function POST(req: NextRequest) {
  const limit = checkRateLimit(getRateLimitKey(req), FORGOT_MAX_PER_MINUTE, 60_000)
  if (!limit.allowed) {
    return NextResponse.json({ error: TOO_MANY_ATTEMPTS_ERROR }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter ?? 60) } })
  }
  const body = bodyObject(await req.json().catch(() => null))
  const r = await requestForgotPassword({ email: body.email, lang: body.lang })
  if (!r.valid) return NextResponse.json({ error: "That email address does not look right." }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, message: FORGOT_ANSWER }, { headers: NO_STORE })
}
