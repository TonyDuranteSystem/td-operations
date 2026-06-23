import { describe, it, expect } from "vitest"
import { shouldRemindNow, DUNNING_RUN_CAP, clampCap, DUNNING_CAP_MAX } from "@/lib/billing/dunning"

describe("shouldRemindNow", () => {
  const cfg = { r1: 7, r2: 14 }

  it("sends the 1st reminder at the r1 threshold when none sent", () => {
    expect(shouldRemindNow({ daysOverdue: 7, reminderCount: 0, ...cfg })).toBe(true)
    expect(shouldRemindNow({ daysOverdue: 10, reminderCount: 0, ...cfg })).toBe(true)
  })

  it("does NOT send before the r1 threshold", () => {
    expect(shouldRemindNow({ daysOverdue: 6, reminderCount: 0, ...cfg })).toBe(false)
  })

  it("does NOT send the 2nd until the r2 threshold", () => {
    expect(shouldRemindNow({ daysOverdue: 10, reminderCount: 1, ...cfg })).toBe(false)
    expect(shouldRemindNow({ daysOverdue: 14, reminderCount: 1, ...cfg })).toBe(true)
  })

  it("caps at 2 reminders total", () => {
    expect(shouldRemindNow({ daysOverdue: 60, reminderCount: 2, ...cfg })).toBe(false)
    expect(shouldRemindNow({ daysOverdue: 60, reminderCount: 3, ...cfg })).toBe(false)
  })

  it("honors custom per-account cadence", () => {
    expect(shouldRemindNow({ daysOverdue: 4, reminderCount: 0, r1: 3, r2: 10 })).toBe(true)
    expect(shouldRemindNow({ daysOverdue: 4, reminderCount: 0, r1: 7, r2: 14 })).toBe(false)
  })

  it("exposes a sane per-run cap", () => {
    expect(DUNNING_RUN_CAP).toBeGreaterThan(0)
    expect(DUNNING_RUN_CAP).toBeLessThanOrEqual(100)
  })
})

describe("clampCap", () => {
  it("keeps valid values", () => {
    expect(clampCap(40)).toBe(40)
    expect(clampCap(1)).toBe(1)
    expect(clampCap(150)).toBe(150)
  })
  it("floors the configured max", () => {
    expect(clampCap(DUNNING_CAP_MAX)).toBe(DUNNING_CAP_MAX)
    expect(clampCap(DUNNING_CAP_MAX + 500)).toBe(DUNNING_CAP_MAX)
  })
  it("falls back to default for junk / non-positive", () => {
    expect(clampCap(0)).toBe(DUNNING_RUN_CAP)
    expect(clampCap(-5)).toBe(DUNNING_RUN_CAP)
    expect(clampCap("abc")).toBe(DUNNING_RUN_CAP)
    expect(clampCap(null)).toBe(DUNNING_RUN_CAP)
  })
  it("floors decimals", () => {
    expect(clampCap(40.9)).toBe(40)
  })
})
