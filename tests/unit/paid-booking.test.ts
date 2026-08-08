/**
 * Paid-call request-flag parsing (WS-A, dev job c0a61e44).
 */
import { describe, it, expect } from "vitest"
import { parsePaidCallRequest } from "@/lib/calendly/paid-booking"


// ─── the flag that shipped as a string and broke the feature silently ─────

describe("parsePaidCallRequest — a malformed flag must not read as 'not a paid call'", () => {
  it("accepts real booleans", () => {
    expect(parsePaidCallRequest({ paid_call: true })).toEqual({ kind: "paid_call", revenueOnly: false })
    expect(parsePaidCallRequest({ paid_call: true, paid_call_revenue_only: true }))
      .toEqual({ kind: "paid_call", revenueOnly: true })
  })

  it("absent or false is simply not a paid call", () => {
    expect(parsePaidCallRequest({}).kind).toBe("not_a_paid_call")
    expect(parsePaidCallRequest({ paid_call: false }).kind).toBe("not_a_paid_call")
    expect(parsePaidCallRequest({ paid_call: null }).kind).toBe("not_a_paid_call")
  })

  it("THE ACTUAL BUG: the string \"true\" is rejected loudly, not treated as false", () => {
    const r = parsePaidCallRequest({ paid_call: "true" })
    expect(r.kind).toBe("invalid")
    expect(r.kind === "invalid" && r.reason).toMatch(/boolean/)
    // it must NOT silently become "not a paid call" — that is what made the
    // failure surface as an unrelated complaint about a missing service type
    expect(r.kind).not.toBe("not_a_paid_call")
  })

  it("other truthy-but-wrong shapes are rejected too", () => {
    for (const bad of [1, "yes", "1", {}, []]) {
      expect(parsePaidCallRequest({ paid_call: bad }).kind).toBe("invalid")
    }
  })

  it("a malformed revenue-only flag is rejected rather than silently ignored", () => {
    const r = parsePaidCallRequest({ paid_call: true, paid_call_revenue_only: "true" })
    expect(r.kind).toBe("invalid")
  })
})
