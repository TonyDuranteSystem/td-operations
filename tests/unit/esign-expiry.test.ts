import { describe, it, expect } from "vitest"
import { describeExpiry, normalizeExpiryDays, DEFAULT_EXPIRY_DAYS, EXPIRY_WARNING_DAYS, EXPIRY_DAY_CHOICES } from "@/lib/esign/expiry"

const NOW = new Date("2026-07-31T12:00:00Z")
const inDays = (d: number) => new Date(NOW.getTime() + d * 86400000).toISOString()

describe("describeExpiry", () => {
  it("treats a missing deadline as normal, not an error (the column is nullable)", () => {
    for (const empty of [null, undefined, ""]) {
      const x = describeExpiry(empty, NOW)
      expect(x.tone).toBe("none")
      expect(x.daysLeft).toBeNull()
    }
  })

  it("survives an unparseable value instead of rendering 'Invalid Date'", () => {
    expect(describeExpiry("not-a-date", NOW).tone).toBe("none")
  })

  it("warns inside the warning window and stays quiet outside it", () => {
    expect(describeExpiry(inDays(EXPIRY_WARNING_DAYS - 1), NOW).tone).toBe("warning")
    expect(describeExpiry(inDays(EXPIRY_WARNING_DAYS + 5), NOW).tone).toBe("normal")
  })

  it("marks a passed deadline", () => {
    const x = describeExpiry(inDays(-1), NOW)
    expect(x.tone).toBe("past")
    expect(x.short).toBe("lapsed")
  })

  it("reads as a scheduled deadline, never as a hard cut-off", () => {
    // The flip is done by a job that runs every 6h and the signing routes gate
    // on status, so a document 'expiring today' still accepts a signature for a
    // few more hours. Saying otherwise would have staff tell a client the door
    // is shut when it is open.
    const x = describeExpiry(inDays(0.2), NOW)
    expect(x.short).toBe("today")
    expect(x.full).not.toMatch(/cannot|can no longer|closed|blocked/i)
  })

  it("defaults to the 30-day window Antonio set", () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(30)
  })
})

describe("normalizeExpiryDays", () => {
  it("accepts each of the three offered windows", () => {
    for (const d of EXPIRY_DAY_CHOICES) expect(normalizeExpiryDays(d)).toBe(d)
  })

  it("accepts them as strings (a form field is a string)", () => {
    expect(normalizeExpiryDays("7")).toBe(7)
    expect(normalizeExpiryDays("14")).toBe(14)
  })

  it("falls back to the default rather than erroring — a bad value must never block a document", () => {
    for (const bad of [0, -5, 1, 21, 365, 9999, null, undefined, "", "abc", {}, NaN]) {
      expect(normalizeExpiryDays(bad)).toBe(DEFAULT_EXPIRY_DAYS)
    }
  })

  it("offers exactly 7, 14 and 30", () => {
    expect([...EXPIRY_DAY_CHOICES]).toEqual([7, 14, 30])
  })
})
