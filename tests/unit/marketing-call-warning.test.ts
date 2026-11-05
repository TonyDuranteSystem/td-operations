import { describe, it, expect } from "vitest"
import { callIsAhead, formatCallTime, resolveStanding } from "@/lib/marketing/call-warning"

describe("the warning on the result buttons: which call stands", () => {
  const T1 = "2026-11-10T14:00:00.000Z", T2 = "2026-11-12T09:00:00.000Z"
  it("with no override the page decides", () => {
    expect(resolveStanding(T1, null)).toBe(T1)
    expect(resolveStanding(null, null)).toBeNull()
  })
  it("the server's refusal (a call the page did not know) counts for that page", () => {
    expect(resolveStanding(null, { forPage: null, callAt: T1 })).toBe(T1)
  })
  it("the person's own cancel clears the warning for that page", () => {
    expect(resolveStanding(T1, { forPage: T1, callAt: null })).toBeNull()
  })
  it("when the page shows ANOTHER call later (moved, re-booked or cancelled from the call box or another tab), the page wins: the warning never sticks on an old time", () => {
    expect(resolveStanding(T2, { forPage: T1, callAt: T1 })).toBe(T2) // moved from the call box
    expect(resolveStanding(null, { forPage: T1, callAt: T1 })).toBeNull() // cancelled from the call box
    expect(resolveStanding(T1, { forPage: null, callAt: null })).toBe(T1) // booked meanwhile
  })
  it("a call stands ahead only while its time is in the future", () => {
    const now = Date.parse("2026-11-10T12:00:00Z")
    expect(callIsAhead(T1, now)).toBe(true)
    expect(callIsAhead("2026-11-10T11:00:00Z", now)).toBe(false)
    expect(callIsAhead(null, now)).toBe(false)
  })
  it("the time is shown in the viewer's zone and language and never crashes the screen", () => {
    expect(formatCallTime(T1, "America/New_York", "en")).toMatch(/9:00|09:00/)
    expect(formatCallTime(T1, "America/New_York", "it")).toMatch(/nov/i)
    expect(formatCallTime(T1, "Not/AZone", "en")).toMatch(/UTC$/)
  })
})
