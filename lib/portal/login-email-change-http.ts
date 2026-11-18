/**
 * How the login-email-change routes answer: one body shape for every refusal, so the screens can show
 * their own (translated) words from `code` and fall back to `error` (R099: never a generic "failed").
 * No answer ever says WHOSE an unavailable email is.
 */
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { loginIdentityFromUser, type LoginIdentity } from "@/lib/portal/login-email-change"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"

const MESSAGES: Record<string, { status: number; error: string }> = {
  invalid_email: { status: 400, error: "That does not look like an email address." },
  same_email: { status: 400, error: "This is already your login email." },
  wrong_password: { status: 403, error: "That password is not right." },
  email_unavailable: { status: 409, error: "We can't use this email. Try a different one, or message us and we will help." },
  too_many_passwords: { status: 429, error: "Too many wrong passwords. Try again later, or message us and we will help." },
  too_many_starts: { status: 429, error: "Too many tries. Try again later, or message us and we will help." },
  locked: { status: 429, error: "Too many wrong codes. Try again in 15 minutes, or message us and we will help." },
  too_many_codes: { status: 429, error: "Too many codes were sent. Try again later, or message us and we will help." },
  wait: { status: 429, error: "Please wait a moment before asking for a new code." },
  wrong_code: { status: 400, error: "That code is not right or has expired. Check the newest email, or send a new code." },
  expired: { status: 400, error: "That code is not right or has expired. Check the newest email, or send a new code." },
  not_found: { status: 404, error: "This change is no longer open. Please start again." },
  busy: { status: 409, error: "Something else was changing at the same moment. Please try again." },
  mail_failed: { status: 502, error: "We could not send the email. Please try again in a moment." },
  failed: { status: 500, error: "Something went wrong. Please try again, or message us." },
  not_allowed: { status: 403, error: "This action is not available for your login." },
  rate_limited: { status: 429, error: "Too many requests. Please wait a moment." },
  // the "This wasn't me" page
  invalid: { status: 400, error: "This link has already been used or has expired. Write to support@tonydurante.us and we will help." },
  used: { status: 400, error: "This link has already been used or has expired. Write to support@tonydurante.us and we will help." },
  superseded: { status: 400, error: "This link has already been used or has expired. Write to support@tonydurante.us and we will help." },
  short: { status: 400, error: "The password must be at least 8 characters." },
  mismatch: { status: 400, error: "The two passwords are not the same." },
}

export function refusal(code: string, extra: { retryAfterSeconds?: number; attemptsLeft?: number } = {}): NextResponse {
  const m = MESSAGES[code] ?? MESSAGES.failed
  const headers: Record<string, string> = {}
  if (extra.retryAfterSeconds) headers["Retry-After"] = String(extra.retryAfterSeconds)
  return NextResponse.json({ ok: false, code, error: m.error, ...extra }, { status: m.status, headers })
}

/** The caller's own login, or the refusal to send. A cheap per-IP limit goes first (the database holds the real limits). */
export async function requireClientLogin(request: Request): Promise<{ identity: LoginIdentity } | { response: NextResponse }> {
  const limit = checkRateLimit(getRateLimitKey(request), 30, 60_000)
  if (!limit.allowed) return { response: refusal("rate_limited", { retryAfterSeconds: limit.retryAfter }) }
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: NextResponse.json({ ok: false, code: "unauthorized", error: "Unauthorized" }, { status: 401 }) }
  const identity = loginIdentityFromUser(user)
  if (!identity) return { response: refusal("not_allowed") }
  return { identity }
}
