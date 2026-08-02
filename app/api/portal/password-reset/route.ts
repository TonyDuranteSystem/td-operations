/**
 * POST /api/portal/password-reset
 *
 * Public, unauthenticated. Accepts { email } from the forgot-password page and
 * runs one reset attempt (see lib/portal/password-reset.ts for the why).
 *
 * ALWAYS answers the same neutral body whether or not the address matched a
 * login — an outsider must not be able to enumerate which addresses have portal
 * accounts. The real outcome is written to action_log, never returned here.
 *
 * KNOWN LIMITATION, stated rather than hidden: the only rate limiter in this repo
 * (lib/portal/rate-limit.ts) is an in-memory Map, i.e. per serverless instance.
 * It is a best-effort speed bump, NOT a guarantee — a distributed prober routed
 * across Vercel instances is not meaningfully limited by it. Treat this route as
 * an outbound-mail amplifier risk until a DB-backed limiter exists.
 */
import { NextResponse } from "next/server"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"
import { runPasswordResetAttempt } from "@/lib/portal/password-reset"
import { PORTAL_BASE_URL } from "@/lib/config"

/** Identical body for every caller — see the neutrality note above. */
const NEUTRAL_BODY = { ok: true } as const

export async function POST(request: Request) {
  const key = getRateLimitKey(request)

  // Charged for EVERY request, matched or not. If the budget were only spent on
  // the matched branch, a 429 would itself become a perfect enumeration signal.
  const limit = checkRateLimit(key, 5, 60_000)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 60) } },
    )
  }

  let email = ""
  try {
    const body = (await request.json()) as { email?: unknown }
    if (typeof body?.email === "string") email = body.email
  } catch {
    // Malformed body — fall through and answer neutrally rather than confirming
    // anything about the request shape.
  }

  await runPasswordResetAttempt({
    rawEmail: email,
    portalBaseUrl: PORTAL_BASE_URL,
    requestKey: key,
  })

  return NextResponse.json(NEUTRAL_BODY)
}
