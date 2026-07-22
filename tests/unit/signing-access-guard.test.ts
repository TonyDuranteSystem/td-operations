/**
 * lib/esign/access-guard.ts — the shared access-code gate for every PUBLIC,
 * token-gated signing route (operating agreement, e-sign, SS-4, Form 8832,
 * signature requests).
 *
 * The bug these tests lock shut: the guard compared the stored code against the
 * supplied one with a length-checked timingSafeEqual. When the stored code was
 * NULL or empty, both sides became a zero-length Buffer and the comparison
 * returned TRUE — so a record with no code on file was readable by anyone
 * holding only the token, which is derivable from a public company name. It
 * failed OPEN, on the one check standing between an anonymous caller and a
 * client's tax ID.
 */
import { describe, it, expect, vi } from "vitest"
import { accessCodeError } from "@/lib/esign/access-guard"

vi.mock("@/lib/portal/rate-limit", () => ({
  checkLoginRateLimit: () => ({ allowed: true }),
  recordLoginFailure: () => {},
  clearLoginFailures: () => {},
}))

// Minimal stand-in — the guard only reads headers via clientIp().
const req = { headers: new Headers() } as unknown as Parameters<typeof accessCodeError>[0]

describe("accessCodeError — blank stored code must FAIL CLOSED", () => {
  it.each([null, undefined, "", "   "])("refuses when the record's code is %p", expected => {
    const err = accessCodeError(req, {
      token: "acme-llc-oa-2026",
      expected: expected as unknown as string,
      provided: "",
      isPreview: false,
    })
    expect(err).not.toBeNull()
    expect(err?.status).toBe(403)
  })

  it("refuses a whitespace-only code — it compares equal to a whitespace answer", () => {
    // Reachable by a manual staff edit. Without the trim, " " vs " " is a match.
    expect(accessCodeError(req, { token: "t", expected: " ", provided: " ", isPreview: false })?.status).toBe(403)
  })

  it("refuses a blank stored code even when the caller supplies something", () => {
    const err = accessCodeError(req, { token: "t", expected: "", provided: "guess", isPreview: false })
    expect(err).not.toBeNull()
  })

  it("does not leak which record it was, or why", () => {
    const err = accessCodeError(req, { token: "t", expected: "", provided: "", isPreview: false })
    expect(err?.error).not.toMatch(/null|empty|blank|missing|token/i)
    expect(err?.error).toContain("support@tonydurante.us")
  })
})

describe("accessCodeError — normal behaviour is unchanged", () => {
  it("passes a correct code", () => {
    expect(accessCodeError(req, { token: "t", expected: "SECRET77", provided: "SECRET77", isPreview: false })).toBeNull()
  })

  it("rejects a wrong code", () => {
    expect(accessCodeError(req, { token: "t", expected: "SECRET77", provided: "nope", isPreview: false })?.status).toBe(403)
  })

  it("rejects an empty answer to a real code", () => {
    expect(accessCodeError(req, { token: "t", expected: "SECRET77", provided: "", isPreview: false })?.status).toBe(403)
  })

  it("staff preview still short-circuits before any of this", () => {
    // isPreview is only ever true after a real session check upstream.
    expect(accessCodeError(req, { token: "t", expected: "", provided: "", isPreview: true })).toBeNull()
  })
})
