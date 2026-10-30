import { describe, it, expect } from "vitest"
import { ROME, isValidZone, zoneParts, offsetMinutes, utcOffsetText, clockText, isoToLocal, localToIso, zoneName, allZones, zoneOptions, COMMON_ZONES } from "@/lib/marketing/zones"
import { romeLocalToIso } from "@/lib/marketing/rome-time"

const CAN = "Atlantic/Canary"
const NY = "America/New_York"

describe("a zone name is checked", () => {
  it("accepts real zones", () => { for (const z of [ROME, CAN, NY, "UTC", "Asia/Kolkata"]) expect(isValidZone(z)).toBe(true) })
  it("refuses made-up, empty and non-text values", () => {
    for (const z of ["Mars/Base", "", "x", "Europe/Rome; drop table", null, undefined, 5, {}, "a".repeat(80)]) expect(isValidZone(z)).toBe(false)
  })
})

describe("the clock in a zone", () => {
  // Fri 30 Oct 2026 15:00 in Rome (UTC+1: Europe left summer time on 25 Oct, the US is still on summer time until 1 Nov)
  const fri = "2026-10-30T14:00:00Z"
  it("Rome, Canary Islands and New York on Fri 30 Oct 2026", () => {
    expect(clockText(fri, ROME)).toBe("15:00"); expect(clockText(fri, CAN)).toBe("14:00"); expect(clockText(fri, NY)).toBe("10:00")
    expect(utcOffsetText(fri, ROME)).toBe("UTC+1"); expect(utcOffsetText(fri, CAN)).toBe("UTC+0"); expect(utcOffsetText(fri, NY)).toBe("UTC-4")
  })
  it("the gap to New York grows from 5 to 6 hours when the US changes its clocks (Tue 3 Nov 2026)", () => {
    const tue = "2026-11-03T14:00:00Z"
    expect(clockText(tue, ROME)).toBe("15:00"); expect(clockText(tue, NY)).toBe("09:00"); expect(utcOffsetText(tue, NY)).toBe("UTC-5")
  })
  it("it is 5 hours again between the US change (14 Mar 2027) and the European one (28 Mar 2027), then 6", () => {
    expect(clockText("2027-03-17T14:00:00Z", NY)).toBe("10:00") // Rome 15:00
    expect(clockText("2027-03-17T14:00:00Z", ROME)).toBe("15:00")
    expect(clockText("2027-04-07T13:00:00Z", ROME)).toBe("15:00"); expect(clockText("2027-04-07T13:00:00Z", NY)).toBe("09:00")
  })
  it("the Canary Islands are always one hour behind Rome, in winter and in summer", () => {
    for (const iso of ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z", "2026-10-26T12:00:00Z", "2027-03-29T12:00:00Z"]) {
      const r = zoneParts(iso, ROME)!, c = zoneParts(iso, CAN)!
      expect((r.h * 60 + r.m) - (c.h * 60 + c.m)).toBe(60)
    }
  })
  it("a half-hour zone is shown with its minutes", () => expect(utcOffsetText("2026-11-03T12:00:00Z", "Asia/Kolkata")).toBe("UTC+5:30"))
  it("a bad date is not a clock", () => { expect(zoneParts("nope", ROME)).toBeNull(); expect(clockText("nope", ROME)).toBe("--:--"); expect(utcOffsetText("nope", ROME)).toBe("") })
  it("offsetMinutes follows the season", () => { expect(offsetMinutes(new Date("2026-07-01T12:00:00Z"), ROME)).toBe(120); expect(offsetMinutes(new Date("2026-12-01T12:00:00Z"), ROME)).toBe(60) })
})

describe("a typed day and time is read in the chosen zone", () => {
  it("Rome gives the same answer the old Rome-only helper gave", () => {
    for (const v of ["2026-10-27T11:00", "2026-07-01T09:30", "2026-03-29T03:30", "2026-10-25T02:30", "2027-01-05T23:45"]) expect(localToIso(v, ROME)).toBe(romeLocalToIso(v))
  })
  it("the same typed time means a different instant in each zone", () => {
    expect(localToIso("2026-11-03T16:00", CAN)).toBe("2026-11-03T16:00:00.000Z")
    expect(localToIso("2026-11-03T11:00", NY)).toBe("2026-11-03T16:00:00.000Z")
    expect(localToIso("2026-11-03T17:00", ROME)).toBe("2026-11-03T16:00:00.000Z")
    expect(localToIso("2026-07-01T16:00", CAN)).toBe("2026-07-01T15:00:00.000Z")
  })
  it("a time around a clock change lands on the right instant", () => {
    expect(localToIso("2026-11-01T12:00", NY)).toBe("2026-11-01T17:00:00.000Z") // the US already left summer time that morning
    expect(localToIso("2026-10-31T12:00", NY)).toBe("2026-10-31T16:00:00.000Z")
  })
  it("refuses dates that do not exist, text that is not a date, and an unknown zone", () => {
    for (const v of ["2026-13-01T10:00", "2026-11-31T10:00", "2026-11-03T25:00", "2026-11-03", "", "tomorrow"]) expect(localToIso(v, NY)).toBeNull()
    expect(localToIso("2026-11-03T10:00", "Mars/Base")).toBeNull()
  })
  it("reads back what it was given", () => {
    for (const z of [ROME, CAN, NY, "America/Sao_Paulo", "Asia/Dubai"]) {
      const iso = localToIso("2026-11-03T16:30", z)!
      expect(isoToLocal(iso, z)).toBe("2026-11-03T16:30")
    }
    expect(isoToLocal("nope", ROME)).toBe("")
  })
})

describe("names and lists", () => {
  it("a readable name", () => {
    expect(zoneName(CAN)).toBe("Canary Islands"); expect(zoneName(NY)).toBe("New York"); expect(zoneName(ROME)).toBe("Rome")
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires")
  })
  it("the list has the common zones first and each zone once, all of them valid", () => {
    const o = zoneOptions()
    expect(o.slice(0, COMMON_ZONES.length).map(x => x.zone)).toEqual(COMMON_ZONES.map(x => x.zone))
    expect(new Set(o.map(x => x.zone)).size).toBe(o.length)
    expect(o.every(x => isValidZone(x.zone))).toBe(true)
    expect(allZones()).toContain(CAN)
  })
})
