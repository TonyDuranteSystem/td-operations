import { afterEach, describe, it, expect } from "vitest"
import {
  cronStatusFromLog,
  formatRelative,
  getSentryStatus,
} from "@/lib/system-health/queries"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe("cronStatusFromLog", () => {
  const now = new Date("2026-04-17T00:00:00Z").getTime()

  it("returns unknown when interval is null", () => {
    expect(cronStatusFromLog(null, null, null, now)).toBe("unknown")
  })

  it("returns red when lastRunAt is null and interval is known", () => {
    expect(cronStatusFromLog(null, null, HOUR, now)).toBe("red")
  })

  it("returns red when last run age exceeds 2x interval (stale)", () => {
    const threeHoursAgo = new Date(now - 3 * HOUR).toISOString()
    expect(cronStatusFromLog(threeHoursAgo, "success", HOUR, now)).toBe("red")
  })

  it("returns red when last run status is error, even if within interval", () => {
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString()
    expect(cronStatusFromLog(fiveMinAgo, "error", HOUR, now)).toBe("red")
  })

  it("returns yellow when age is between 1x and 2x interval", () => {
    const ninetyMinAgo = new Date(now - 90 * 60 * 1000).toISOString()
    expect(cronStatusFromLog(ninetyMinAgo, "success", HOUR, now)).toBe("yellow")
  })

  it("returns green when age is within interval and last status is success", () => {
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString()
    expect(cronStatusFromLog(tenMinAgo, "success", HOUR, now)).toBe("green")
  })

  it("returns green when age is within interval and last status is unknown (null)", () => {
    // a cron that ran recently but whose status wasn't one of success/error
    // should still be considered live, not error-state
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString()
    expect(cronStatusFromLog(tenMinAgo, null, HOUR, now)).toBe("green")
  })

  it("weekly cron within the week is green", () => {
    const threeDaysAgo = new Date(now - 3 * DAY).toISOString()
    expect(cronStatusFromLog(threeDaysAgo, "success", 7 * DAY, now)).toBe("green")
  })

  it("weekly cron later than 2x week is red", () => {
    const sixteenDaysAgo = new Date(now - 16 * DAY).toISOString()
    expect(cronStatusFromLog(sixteenDaysAgo, "success", 7 * DAY, now)).toBe("red")
  })
})

describe("formatRelative", () => {
  const now = 1_700_000_000_000

  it("returns 'never' when age is null", () => {
    expect(formatRelative(null, now)).toBe("never")
  })

  it("formats seconds", () => {
    expect(formatRelative(5_000, now)).toBe("5s ago")
  })

  it("formats minutes", () => {
    expect(formatRelative(5 * 60_000, now)).toBe("5m ago")
  })

  it("formats hours", () => {
    expect(formatRelative(5 * HOUR, now)).toBe("5h ago")
  })

  it("formats days beyond 48h", () => {
    expect(formatRelative(5 * DAY, now)).toBe("5d ago")
  })

  it("rolls up 48h+ into days", () => {
    expect(formatRelative(3 * DAY, now)).toBe("3d ago")
  })
})

describe("getSentryStatus", () => {
  const originalDsn = process.env.NEXT_PUBLIC_SENTRY_DSN

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.NEXT_PUBLIC_SENTRY_DSN
    } else {
      process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsn
    }
  })

  it("returns available=false regardless of DSN (API not wired)", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const result = getSentryStatus()
    expect(result.available).toBe(false)
    expect(result.reason).toContain("Sentry API not wired")
  })

  it("extracts dashboardUrl from a standard ingest-host DSN", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://abcdef1234567890@o12345.ingest.sentry.io/7890123"
    const result = getSentryStatus()
    expect(result.available).toBe(false)
    expect(result.dashboardUrl).toBe(
      "https://ingest.sentry.io/issues/?query=dbWrite%5B",
    )
  })

  it("returns dashboardUrl=null when DSN is not present", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const result = getSentryStatus()
    expect(result.dashboardUrl).toBeNull()
  })

  it("returns dashboardUrl=null when DSN is malformed", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "not-a-valid-dsn"
    const result = getSentryStatus()
    expect(result.dashboardUrl).toBeNull()
  })
})
