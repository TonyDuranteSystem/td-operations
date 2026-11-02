import { describe, it, expect } from "vitest"
import { jointSlots, jointSlotStillFree, ownerFree } from "@/lib/marketing/joint-slots"
import { resolveCallHours } from "@/lib/marketing/time-prefs"

// November 2026, after both clocks changed: the Canary Islands are UTC+0, New York is UTC-5.
const U = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m)
const SELLER_ZONE = "Atlantic/Canary"
const OWNER = { zone: "America/New_York", hours: { startMin: 480, endMin: 810, days: [1, 2, 3, 4, 5], notice: 120 }, busy: [] as Array<{ start: number; end: number }> }
const HOURS = resolveCallHours(undefined) // 09:00-18:00 Mon-Fri, 30-minute slots, 15-minute gap
const base = { sellerZone: SELLER_ZONE, sellerHours: HOURS, sellerBusy: [] as Array<{ start: number; end: number }>, owner: OWNER, nowMs: U(2, 0) }
const dayStarts = (day: number) => jointSlots(base).filter(t => new Date(t).getUTCDate() === day)

describe("jointSlots", () => {
  it("offers only the overlap of the seller's hours and the owner's hours", () => {
    const s = dayStarts(3) // Tuesday: owner 13:00-18:30 UTC, seller 09:00-18:00 UTC
    expect(s[0]).toBe(U(3, 13, 0))
    expect(s[s.length - 1]).toBe(U(3, 17, 30))
    expect(s).toHaveLength(10)
  })

  it("never offers a time outside the owner's hours even when the seller is free", () => {
    expect(dayStarts(3).some(t => t < U(3, 13, 0))).toBe(false)
  })

  it("keeps the 1:30 pm New York end: a slot may not run past it", () => {
    const wide = { ...base, sellerHours: resolveCallHours({ end: 24 }) }
    const s = jointSlots(wide).filter(t => new Date(t).getUTCDate() === 3)
    expect(s[s.length - 1]).toBe(U(3, 18, 0)) // 18:00 to 18:30 UTC = 1:00 to 1:30 pm New York
  })

  it("drops a time when the owner is busy, with the gap around it", () => {
    const busy = [{ start: U(3, 14, 0), end: U(3, 14, 30) }]
    const s = jointSlots({ ...base, owner: { ...OWNER, busy } }).filter(t => new Date(t).getUTCDate() === 3)
    expect(s).toContain(U(3, 13, 0))
    expect(s).not.toContain(U(3, 13, 30))
    expect(s).not.toContain(U(3, 14, 0))
    expect(s).not.toContain(U(3, 14, 30))
    expect(s).toContain(U(3, 15, 0))
  })

  it("drops a time when the seller is busy", () => {
    const sellerBusy = [{ start: U(3, 15, 0), end: U(3, 16, 0) }]
    const s = jointSlots({ ...base, sellerBusy }).filter(t => new Date(t).getUTCDate() === 3)
    expect(s).not.toContain(U(3, 15, 0))
    expect(s).not.toContain(U(3, 15, 30))
    expect(s).toContain(U(3, 13, 0))
  })

  it("respects the owner's shortest notice", () => {
    const s = jointSlots({ ...base, nowMs: U(3, 12, 0) }).filter(t => new Date(t).getUTCDate() === 3)
    expect(s[0]).toBe(U(3, 14, 0)) // 12:00 now + 2 hours
  })

  it("offers nothing on a day the owner does not work", () => {
    expect(jointSlots({ ...base, owner: { ...OWNER, hours: { ...OWNER.hours, days: [1] } } }).filter(t => new Date(t).getUTCDate() === 3)).toEqual([])
  })

  it("offers nothing at the weekend", () => {
    expect(jointSlots(base).filter(t => [7, 8].includes(new Date(t).getUTCDate()))).toEqual([])
  })
})

describe("ownerFree", () => {
  it("is false for a call that crosses the owner's midnight", () => {
    const o = { ...OWNER, hours: { startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], notice: 0 } }
    expect(ownerFree(U(3, 4, 45), U(3, 5, 15), o, 0, 0)).toBe(false) // 23:45 to 00:15 New York
    expect(ownerFree(U(3, 14, 0), U(3, 14, 30), o, 0, 0)).toBe(true)
  })

  it("treats 24:00 as the end of the day", () => {
    const o = { ...OWNER, hours: { startMin: 1200, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], notice: 0 } }
    expect(ownerFree(U(4, 4, 0), U(4, 4, 30), o, 0, 0)).toBe(true) // 23:00-23:30 New York on the 3rd
  })
})

describe("jointSlotStillFree", () => {
  it("is true for an offered start and false once it is taken", () => {
    expect(jointSlotStillFree(U(3, 13, 0), base)).toBe(true)
    expect(jointSlotStillFree(U(3, 13, 0), { ...base, sellerBusy: [{ start: U(3, 13, 0), end: U(3, 13, 30) }] })).toBe(false)
    expect(jointSlotStillFree(U(3, 13, 7), base)).toBe(false) // not on a half hour
  })
})
