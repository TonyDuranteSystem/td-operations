import { describe, it, expect } from "vitest"
import {
  DEFAULT_STAFF_TIME_ZONE,
  formatLocalDate,
  formatLocalStamp,
  isValidYmd,
  localDayStartUtc,
  nextYmd,
  resolveStaffTimeZone,
} from "@/lib/inbox/staff-time-zone"

describe("resolveStaffTimeZone — a browser-sent zone is a display preference, never trusted blindly", () => {
  it.each(["America/New_York", "Europe/Rome", "UTC", "America/Argentina/Buenos_Aires", "Asia/Kolkata"])("keeps the real zone %s", (zone) => {
    expect(resolveStaffTimeZone(zone)).toBe(zone)
  })

  it.each([undefined, null, 42, {}, "", "   ", "Mars/Phobos", "../../etc/passwd", "America/New_York; DROP TABLE", "x".repeat(80)])(
    "falls back to New York for %j",
    (bad) => {
      expect(resolveStaffTimeZone(bad)).toBe(DEFAULT_STAFF_TIME_ZONE)
    },
  )

  it("the business default is New York", () => {
    expect(DEFAULT_STAFF_TIME_ZONE).toBe("America/New_York")
  })
})

describe("formatLocalStamp — the clock time the staff member sees", () => {
  it("the Sep 21 closure-price message: 13:49 UTC is 09:49 on a New York screen", () => {
    expect(formatLocalStamp("2026-09-21T13:49:55.142168+00:00", "America/New_York")).toBe("2026-09-21 09:49 EDT")
  })

  it("winter time is EST, not EDT", () => {
    expect(formatLocalStamp("2026-12-21T13:49:00Z", "America/New_York")).toBe("2026-12-21 08:49 EST")
  })

  it("keeps the old UTC wording when no zone is given", () => {
    expect(formatLocalStamp("2026-09-21T13:49:55Z")).toBe("2026-09-21 13:49 UTC")
    expect(formatLocalStamp("2026-09-21T13:49:55Z", "UTC")).toBe("2026-09-21 13:49 UTC")
  })

  it("survives a missing or invalid time", () => {
    expect(formatLocalStamp(null, "America/New_York")).toBe("time unknown")
    expect(formatLocalStamp("not a date", "America/New_York")).toBe("time unknown")
  })

  it("midnight reads 00:xx, never 24:xx", () => {
    expect(formatLocalStamp("2026-09-21T04:05:00Z", "America/New_York")).toBe("2026-09-21 00:05 EDT")
  })
})

describe("formatLocalDate", () => {
  it("is the date on the staff member's calendar, which can differ from UTC's", () => {
    expect(formatLocalDate("2026-11-03T02:30:00Z", "America/New_York")).toBe("2026-11-02")
    expect(formatLocalDate("2026-11-03T02:30:00Z", "UTC")).toBe("2026-11-03")
  })
})

describe("isValidYmd / nextYmd", () => {
  it("accepts real dates only", () => {
    expect(isValidYmd("2026-09-21")).toBe(true)
    expect(isValidYmd("2028-02-29")).toBe(true)
    for (const bad of ["2026-02-30", "2026-13-01", "2026-9-1", "21-09-2026", "abc", "", "2026-09-21T10:00"]) expect(isValidYmd(bad)).toBe(false)
  })

  it("steps over month and year ends", () => {
    expect(nextYmd("2026-09-30")).toBe("2026-10-01")
    expect(nextYmd("2026-12-31")).toBe("2027-01-01")
    expect(nextYmd("2028-02-28")).toBe("2028-02-29")
    expect(nextYmd("garbage")).toBe("garbage")
  })
})

describe("localDayStartUtc — where a calendar day begins in the staff member's zone", () => {
  const iso = (ymd: string, tz: string) => localDayStartUtc(ymd, tz)?.toISOString()

  it("New York summer day starts at 04:00 UTC, winter at 05:00 UTC", () => {
    expect(iso("2026-09-21", "America/New_York")).toBe("2026-09-21T04:00:00.000Z")
    expect(iso("2026-12-21", "America/New_York")).toBe("2026-12-21T05:00:00.000Z")
  })

  it("is right on the two daylight-saving change days", () => {
    // Clocks go back on Sunday Nov 1 2026 (midnight is still summer time) and forward on Sunday Mar 8 2026 (midnight is still winter time).
    expect(iso("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z")
    expect(iso("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z")
    expect(iso("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z")
    expect(iso("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z")
  })

  it("works for a zone ahead of UTC and for UTC itself", () => {
    expect(iso("2026-09-21", "Europe/Rome")).toBe("2026-09-20T22:00:00.000Z")
    expect(iso("2026-09-21", "UTC")).toBe("2026-09-21T00:00:00.000Z")
  })

  it("is null for a date that does not exist", () => {
    expect(localDayStartUtc("2026-02-30", "America/New_York")).toBeNull()
  })
})
