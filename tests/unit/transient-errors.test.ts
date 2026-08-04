import { describe, it, expect } from "vitest"
import {
  isTransientStatus,
  retryDelayMs,
  canRetryWithin,
  explainWorkerFailure,
  MAX_TRANSIENT_RETRIES,
} from "@/lib/ai-agent/transient-errors"

/**
 * The failure Luca actually hit (td-bug, 2026-07-29): mid-way through a
 * spreadsheet conversation the panel printed
 *   ⚠️ Claude API error 529: {"type":"error","error":{"type":"overloaded_error"…
 * twice in a row, with no retry. He read it as a problem with his FILE and spent
 * days converting formats. Both halves are tested here: retry the transient
 * failure, and never let it read as the user's fault.
 */
describe("isTransientStatus", () => {
  it("retries provider overload, rate limits and gateway failures", () => {
    for (const s of [429, 500, 502, 503, 504, 529]) expect(isTransientStatus(s)).toBe(true)
  })

  it("does NOT retry a request that is actually wrong", () => {
    // Retrying these burns the turn's clock to fail the same way.
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isTransientStatus(s)).toBe(false)
  })
})

describe("retryDelayMs", () => {
  it("backs off, and stops growing at the cap", () => {
    expect(retryDelayMs(1)).toBe(1000)
    expect(retryDelayMs(2)).toBe(2000)
    expect(retryDelayMs(3)).toBe(4000)
    expect(retryDelayMs(9)).toBe(8000)
  })

  it("honours a Retry-After given in seconds", () => {
    expect(retryDelayMs(1, "3")).toBe(3000)
  })

  it("clamps an absurd or hostile Retry-After so it cannot park the turn", () => {
    expect(retryDelayMs(1, "99999")).toBe(10_000)
  })

  it("falls back to backoff when Retry-After is unparseable", () => {
    expect(retryDelayMs(2, "soon")).toBe(2000)
  })

  it("treats a Retry-After date already in the past as no wait", () => {
    expect(retryDelayMs(1, new Date(Date.now() - 60_000).toUTCString())).toBe(0)
  })
})

describe("canRetryWithin — a retry that cannot finish must not start", () => {
  it("allows a retry with room to spare", () => {
    expect(canRetryWithin(10_000, 250_000, 1000)).toBe(true)
  })

  it("refuses when the turn is nearly out of time", () => {
    // 240s spent of a 250s budget: a 1s wait plus a useful call does not fit.
    expect(canRetryWithin(240_000, 250_000, 1000)).toBe(false)
  })

  it("bounds the number of attempts as well as the clock", () => {
    expect(MAX_TRANSIENT_RETRIES).toBeGreaterThan(0)
    expect(MAX_TRANSIENT_RETRIES).toBeLessThanOrEqual(5)
  })
})

describe("explainWorkerFailure — never blame the user's file", () => {
  const raw529 =
    'Claude API error 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

  it("turns the exact 529 Luca saw into a plain sentence, with no raw payload", () => {
    const out = explainWorkerFailure(new Error(raw529))
    expect(out).not.toContain("529")
    expect(out).not.toContain("{")
    expect(out).not.toMatch(/overloaded_error/)
    expect(out).toMatch(/overloaded/i)
    expect(out).toMatch(/try again/i)
  })

  it("says explicitly that nothing the staff member sent is at fault", () => {
    // THE point of this function. Luca converted Numbers → Excel → CSV chasing a
    // problem that was never in his file.
    for (const err of [raw529, "Claude API error 503: {}", "Claude API error 429: {}"]) {
      expect(explainWorkerFailure(new Error(err))).toMatch(/nothing is wrong with anything you sent/i)
    }
  })

  it("explains a timeout as a timeout, and says nothing was changed", () => {
    const out = explainWorkerFailure(new Error("This operation was aborted"))
    expect(out).toMatch(/too long/i)
    expect(out).toMatch(/nothing was changed/i)
  })

  it("explains an over-long request as size, and suggests something actionable", () => {
    const out = explainWorkerFailure(new Error("Claude API error 400: prompt is too long"))
    expect(out).toMatch(/too large/i)
    expect(out).toMatch(/fresh conversation|one file at a time/i)
  })

  it("routes an auth failure to us, not to the staff member", () => {
    const out = explainWorkerFailure(new Error("Claude API error 401: {}"))
    expect(out).toMatch(/configuration/i)
  })

  it("still produces a plain sentence for something it has never seen", () => {
    const out = explainWorkerFailure(new Error("kaboom"))
    expect(out).not.toContain("kaboom")
    expect(out.length).toBeGreaterThan(20)
  })
})
