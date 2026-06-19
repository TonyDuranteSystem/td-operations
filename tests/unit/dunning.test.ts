import { describe, it, expect } from "vitest"
import { shouldRemindNow, DUNNING_RUN_CAP } from "@/lib/billing/dunning"

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
