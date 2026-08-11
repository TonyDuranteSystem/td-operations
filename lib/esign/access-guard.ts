/**
 * Shared access-code verification for the public signer routes (fetch / submit /
 * decline / pdf). Two hardenings over a bare `access_code !== code`:
 *  - constant-time comparison (no timing oracle on the code), and
 *  - per-(IP, token) failed-attempt lockout (best-effort, in-memory).
 *
 * ⚠️ ENTROPY REALITY (do not repeat the old "codes are already 128-bit" claim,
 * which was FALSE for this family): the OA access code and the per-signer code
 * both DEFAULT to 8 hex chars = 32 bits (see the oa_signatures.access_code /
 * oa_agreements.access_code DB defaults). Only the esign_signers UUID codes are
 * 128-bit. So the lockout here is NOT mere hardening on top of a strong secret —
 * for the OA family it is load-bearing, and the OA fetch route adds its own
 * throughput cap + records a failure on a bad per-signer code so the signer
 * dimension is throttled too. Any code this system ROTATES (die-on-change /
 * re-send / reissue) is minted full-length (128-bit) to close the gap going forward.
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
