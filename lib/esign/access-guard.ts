/**
 * Shared access-code verification for the public signer routes (fetch / submit /
 * decline / pdf). Two hardenings over a bare `access_code !== code`:
 *  - constant-time comparison (no timing oracle on the code), and
 *  - per-(IP, token) failed-attempt lockout (best-effort, in-memory — the codes
 *    are already 128-bit, so this is defense-in-depth against obvious hammering).
 * Preview mode (?preview=td) skips the code, exactly as before — but it still
 * requires the secret per-signer token, so it does not widen exposure.
 */

import { timingSafeEqual } from "crypto"
import type { NextRequest } from "next/server"
import { clientIp } from "@/lib/esign/request-meta"
import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures } from "@/lib/portal/rate-limit"

/** Constant-time string compare (length-safe). */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? "", "utf8")
  const bb = Buffer.from(b ?? "", "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Returns null when the request may proceed, or an error to return otherwise.
 * Records/locks failed attempts; clears the counter on success.
 */
export function accessCodeError(
  req: NextRequest,
  opts: { token: string; expected: string; provided: string; isPreview: boolean },
): { status: number; error: string } | null {
  if (opts.isPreview) return null

  // FAIL CLOSED when the record has no usable code on file. Without this, an
  // empty or NULL `expected` compares equal to an empty `provided` — both become
  // a zero-length Buffer and timingSafeEqual returns true — so such a record
  // would be readable by anyone holding only the token, with no credential at
  // all. `.trim()` closes the same hole for a whitespace-only code, which is
  // reachable by a manual staff edit and would otherwise still compare equal.
  //
  // Nothing legitimate has a blank code (verified on production: zero across
  // oa_agreements 0/187 and esign_signers 0/26), so refusing is never a false
  // denial. The branch can only ever DENY — it adds no path that returns null.
  //
  // Scope note, because the first version of this comment overstated it: the
  // ONLY callers of this guard are the operating-agreement fetch route and the
  // four e-sign routes. SS-4, Form 8832 and signature-request do their own bare
  // `!==` compare and are NOT covered here — nor were they ever exposed this
  // way, since `null !== ""` is true and already blocked those rows.
  if (!opts.expected?.trim()) {
    return { status: 403, error: "This signing link is not available. Please contact support@tonydurante.us." }
  }

  const key = `esign:${clientIp(req) || "unknown"}:${opts.token}`

  const rl = checkLoginRateLimit(key)
  if (!rl.allowed) {
    return { status: 429, error: "Too many attempts. Please wait a few minutes and try again." }
  }
  if (!timingSafeStrEqual(opts.expected || "", opts.provided || "")) {
    recordLoginFailure(key)
    return { status: 403, error: "Invalid access code." }
  }
  clearLoginFailures(key)
  return null
}
