/**
 * Pins WHERE the blank-code branch sits in lib/esign/access-guard.ts.
 *
 * The main suite for this guard mocks the rate-limit module wholesale, so the
 * placement decision it exists to make is unasserted there: move the blank-code
 * branch below the rate-limit check and every one of those tests still passes.
 * This file uses the REAL limiter.
 *
 * Getting a USEFUL assertion here took two attempts, which is the part worth
 * recording. The obvious version — hammer a blank-code request 25 times and
 * expect 403 every time — ALSO passes on the wrong placement, because the blank
 * branch returns before `recordLoginFailure` either way, so the limiter never
 * locks and never gets the chance to answer differently. A guard test that
 * passes against the very bug it guards is worse than no test: it reads as proof.
 *
 * The distinguishing setup is to lock the key FIRST with real wrong-code
 * attempts, and only then send the blank-code request:
 *   - branch BEFORE the limiter (correct)   -> 403; the limiter is never consulted
 *   - branch AFTER the limiter (regression) -> 429; the lockout answers first
 * Confirmed by temporarily moving the branch and watching this file fail.
 */
import { describe, it, expect } from "vitest"
import { accessCodeError } from "@/lib/esign/access-guard"
import { LOGIN_MAX_FAILURES } from "@/lib/portal/rate-limit"

const reqFrom = (ip: string) =>
  ({ headers: new Headers([["x-forwarded-for", ip]]) }) as unknown as Parameters<typeof accessCodeError>[0]

describe("the blank-code branch runs BEFORE the rate limiter", () => {
  it("still answers 403 (not 429) on a key that is already locked out", () => {
    const req = reqFrom("203.0.113.77")
    const token = "ordering-probe-locked"

    // Lock the (IP, token) key with real wrong-code attempts.
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      accessCodeError(req, { token, expected: "REALCODE", provided: "wrong", isPreview: false })
    }
    // Sanity: the lockout really is engaged for a normal request.
    expect(accessCodeError(req, { token, expected: "REALCODE", provided: "wrong", isPreview: false })?.status).toBe(429)

    // The blank-code branch must short-circuit ahead of that lockout.
    expect(accessCodeError(req, { token, expected: "", provided: "", isPreview: false })?.status).toBe(403)
  })

  it("burns no lockout budget of its own", () => {
    const req = reqFrom("203.0.113.88")
    const token = "ordering-probe-budget"

    for (let i = 0; i < LOGIN_MAX_FAILURES * 3; i++) {
      expect(accessCodeError(req, { token, expected: "", provided: "", isPreview: false })?.status).toBe(403)
    }
    // A legitimate request on the same key is untouched by all of that.
    expect(accessCodeError(req, { token, expected: "REALCODE", provided: "REALCODE", isPreview: false })).toBeNull()
  })
})
