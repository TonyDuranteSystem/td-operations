import { describe, it, expect } from "vitest"
import { describeExpiry, DEFAULT_EXPIRY_DAYS, EXPIRY_WARNING_DAYS } from "@/lib/esign/expiry"

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
