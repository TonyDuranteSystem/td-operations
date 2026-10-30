import { describe, it, expect } from "vitest"
import { romeParts, slotIso, moveToDay, bucketOf, bucketDrop, romeLocalValue, weekDays } from "@/lib/marketing/calendar-grid"

const CAN = "Atlantic/Canary"
const NY = "America/New_York"

describe("the Calendar's day and hour follow the zone it is read in (Addendum K)", () => {
  // Tue 3 Nov 2026, 16:00 UTC = 17:00 Rome, 16:00 Canary, 11:00 New York
  const at = "2026-11-03T16:00:00Z"
  it("the same call is on a different hour, and sometimes a different day, in each zone", () => {
    expect(romeParts(at)).toEqual({ key: "2026-11-03", h: 17, m: 0 })
    expect(romeParts(at, CAN)).toEqual({ key: "2026-11-03", h: 16, m: 0 })
    expect(romeParts(at, NY)).toEqual({ key: "2026-11-03", h: 11, m: 0 })
    // 02:00 UTC on Wed is still Tuesday evening in New York
    expect(romeParts("2026-11-04T02:00:00Z", NY)).toEqual({ key: "2026-11-03", h: 21, m: 0 })
    expect(romeParts("2026-11-04T02:00:00Z")?.key).toBe("2026-11-04")
  })
  it("with no zone given everything reads Rome, as before", () => {
    expect(slotIso("2026-11-03", 17, 0)).toBe("2026-11-03T16:00:00.000Z")
    expect(romeLocalValue(at)).toBe("2026-11-03T17:00")
  })
  it("a slot dropped on a day is read in the viewer's zone", () => {
    expect(slotIso("2026-11-03", 11, 0, NY)).toBe(at.replace("Z", ".000Z"))
    expect(slotIso("2026-11-03", 16, 0, CAN)).toBe("2026-11-03T16:00:00.000Z")
  })
  it("a call keeps its time of day IN THE VIEWER'S ZONE when it is moved to another day", () => {
    expect(moveToDay(at, "2026-11-05", NY)).toBe("2026-11-05T16:00:00.000Z")
    // across the US clock change of Sun 1 Nov 2026: 11:00 New York is 15:00Z before it and 16:00Z after it
    expect(moveToDay("2026-10-30T15:00:00Z", "2026-11-03", NY)).toBe("2026-11-03T16:00:00.000Z")
  })
  it("Today and Tomorrow are the viewer's days", () => {
    // 23:30 Tue 3 Nov in New York is 04:30Z Wed 4 Nov: already "tomorrow" for Rome and "today" for New York
    const now = "2026-11-04T04:30:00Z"
    expect(bucketOf("2026-11-04T10:00:00Z", now, NY)).toBe("tomorrow")
    expect(bucketOf("2026-11-04T10:00:00Z", now)).toBe("today")
  })
  it("late in the evening there is no hour left today, so a drop on Today asks for a day (in the viewer's zone)", () => {
    const now = "2026-11-04T04:30:00Z" // 23:30 in New York
    const d = bucketDrop("today", "2026-11-05T15:00:00Z", now, NY)
    expect(d.kind).toBe("choose")
  })
  it("a week starts on the same Monday whatever the zone (it is a day key)", () => expect(weekDays("2026-11-03")[0]).toBe("2026-11-02"))
})
