/**
 * Reminder targeting + cadence. These rules are shared by the automatic cron
 * and the staff button; a divergence here means a real client is either chased
 * twice or never chased at all.
 */

import { describe, it, expect } from "vitest"
import {
  selectReminderTargets,
  shouldSendAutoReminder,
  isManualReminderThrottled,
  remindersInCurrentCycle,
  REMINDER_AFTER_HOURS,
  MAX_REMINDERS,
  MANUAL_REMINDER_COOLDOWN_HOURS,
} from "@/lib/esign/reminder-targeting"

const NOW = new Date("2026-07-31T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString()

const s = (status: string, signing_order = 1) => ({ status, signing_order })

describe("selectReminderTargets", () => {
  it("never targets a pending signer — they were never invited", () => {
    // A 'reminder' to a pending signer sends the FIRST invite, leaves them
    // pending, so the Send button stays live and staff then send it AGAIN.
    const out = selectReminderTargets([s("pending", 1), s("sent", 2)], "parallel")
    expect(out.map(x => x.status)).toEqual(["sent"])
  })

  it("skips signed and declined signers", () => {
    const out = selectReminderTargets([s("signed", 1), s("declined", 2), s("viewed", 3)], "parallel")
    expect(out.map(x => x.status)).toEqual(["viewed"])
  })

  it("chases everyone outstanding on a parallel envelope", () => {
    const out = selectReminderTargets([s("sent", 1), s("viewed", 2)], "parallel")
    expect(out).toHaveLength(2)
  })

  it("chases only whoever's turn it is on a sequential envelope", () => {
    const out = selectReminderTargets([s("viewed", 2), s("sent", 1)], "sequential")
    expect(out).toHaveLength(1)
    expect(out[0].signing_order).toBe(1)
  })

  it("returns nothing when everyone has signed", () => {
    expect(selectReminderTargets([s("signed", 1), s("signed", 2)], "parallel")).toEqual([])
  })
})

describe("shouldSendAutoReminder", () => {
  it("waits out the quiet period", () => {
    expect(
      shouldSendAutoReminder({ sentAt: hoursAgo(REMINDER_AFTER_HOURS - 1), reminderTimes: [], now: NOW }),
    ).toBe(false)
    expect(
      shouldSendAutoReminder({ sentAt: hoursAgo(REMINDER_AFTER_HOURS + 1), reminderTimes: [], now: NOW }),
    ).toBe(true)
  })

  it("stops at the cap", () => {
    const old = [hoursAgo(200), hoursAgo(150)]
    expect(old).toHaveLength(MAX_REMINDERS)
    expect(shouldSendAutoReminder({ sentAt: hoursAgo(400), reminderTimes: old, now: NOW })).toBe(false)
  })

  it("measures the quiet period from the LAST reminder, not the first", () => {
    expect(
      shouldSendAutoReminder({ sentAt: hoursAgo(400), reminderTimes: [hoursAgo(1)], now: NOW }),
    ).toBe(false)
    expect(
      shouldSendAutoReminder({ sentAt: hoursAgo(400), reminderTimes: [hoursAgo(100)], now: NOW }),
    ).toBe(true)
  })

  it("never fires for a signer who was never sent anything", () => {
    expect(shouldSendAutoReminder({ sentAt: null, reminderTimes: [], now: NOW })).toBe(false)
  })
})

describe("remindersInCurrentCycle", () => {
  it("counts everything when the envelope was never reopened", () => {
    const times = [hoursAgo(10), hoursAgo(50)]
    expect(remindersInCurrentCycle(times, null)).toEqual(times)
  })

  it("drops reminders raised before the reopen, so a reopened document is chased again", () => {
    // Without this, a reopened envelope inherits its exhausted budget and gets
    // ZERO automatic follow-ups for its whole new window.
    const times = [hoursAgo(2), hoursAgo(300), hoursAgo(400)]
    const cycle = remindersInCurrentCycle(times, hoursAgo(24))
    expect(cycle).toEqual([hoursAgo(2)])
    expect(shouldSendAutoReminder({ sentAt: hoursAgo(500), reminderTimes: cycle, now: NOW })).toBe(false)
    expect(
      shouldSendAutoReminder({ sentAt: hoursAgo(500), reminderTimes: [], now: NOW }),
    ).toBe(true)
  })
})

describe("isManualReminderThrottled", () => {
  it("blocks a repeat nudge inside the cooldown", () => {
    expect(
      isManualReminderThrottled({ reminderTimes: [hoursAgo(MANUAL_REMINDER_COOLDOWN_HOURS - 1)], now: NOW }),
    ).toBe(true)
  })

  it("allows one after the cooldown", () => {
    expect(
      isManualReminderThrottled({ reminderTimes: [hoursAgo(MANUAL_REMINDER_COOLDOWN_HOURS + 1)], now: NOW }),
    ).toBe(false)
  })

  it("counts automatic reminders too — the client can't tell them apart", () => {
    expect(isManualReminderThrottled({ reminderTimes: [hoursAgo(1), hoursAgo(500)], now: NOW })).toBe(true)
  })

  it("allows the first ever nudge", () => {
    expect(isManualReminderThrottled({ reminderTimes: [], now: NOW })).toBe(false)
  })
})
