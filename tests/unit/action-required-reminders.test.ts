import { describe, it, expect } from "vitest"
import {
  decideSs4ClientReminder,
  decideStaleDraftAlert,
  REMIND_AFTER_DAYS,
  MAX_REMINDERS,
  STAFF_ALERT_AFTER_DAYS,
  STAFF_ALERT_REPEAT_DAYS,
} from "@/lib/portal/action-required-reminders"

const NOW = new Date("2026-07-10T13:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

describe("decideSs4ClientReminder", () => {
  it("skips anything not awaiting signature (resolution-aware)", () => {
    for (const status of ["draft", "signed", "submitted", "done"]) {
      const d = decideSs4ClientReminder({ ss4Status: status, awaitingSince: daysAgo(30), notifCount: 1, lastNotifAt: daysAgo(10), now: NOW })
      expect(d.action).toBe("skip")
    }
  })

  it("straggler with zero notifications gets the INITIAL once past the threshold", () => {
    const d = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(REMIND_AFTER_DAYS + 1), notifCount: 0, lastNotifAt: null, now: NOW })
    expect(d.action).toBe("initial")
  })

  it("fresh transition with zero notifications is left to the trigger sites", () => {
    const d = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(1), notifCount: 0, lastNotifAt: null, now: NOW })
    expect(d.action).toBe("skip")
  })

  it("reminds after the silence threshold, numbering the reminder", () => {
    const d = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(10), notifCount: 1, lastNotifAt: daysAgo(REMIND_AFTER_DAYS + 1), now: NOW })
    expect(d).toMatchObject({ action: "reminder", reminderNumber: 1 })
    const d2 = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(10), notifCount: 2, lastNotifAt: daysAgo(REMIND_AFTER_DAYS + 1), now: NOW })
    expect(d2).toMatchObject({ action: "reminder", reminderNumber: 2 })
  })

  it("does NOT remind inside the silence window", () => {
    const d = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(10), notifCount: 1, lastNotifAt: daysAgo(1), now: NOW })
    expect(d.action).toBe("skip")
  })

  it("stops at MAX_REMINDERS", () => {
    const d = decideSs4ClientReminder({ ss4Status: "awaiting_signature", awaitingSince: daysAgo(30), notifCount: 1 + MAX_REMINDERS, lastNotifAt: daysAgo(10), now: NOW })
    expect(d.action).toBe("skip")
    expect(d.reason).toContain("max reminders")
  })
})

describe("decideStaleDraftAlert", () => {
  const base = { sdStage: "SS-4 Prepared", stageEnteredAt: daysAgo(10), lastAlertAt: null, now: NOW }

  it("alerts on a draft SS-4 past the grace window", () => {
    const d = decideStaleDraftAlert({ ...base, ss4Status: "draft", ss4UpdatedAt: daysAgo(STAFF_ALERT_AFTER_DAYS + 1) })
    expect(d.alert).toBe(true)
  })

  it("alerts when NO SS-4 exists (generation failed), anchored on stage entry", () => {
    const d = decideStaleDraftAlert({ ...base, ss4Status: null, ss4UpdatedAt: null })
    expect(d.alert).toBe(true)
    expect(d.reason).toContain("no SS-4 generated")
  })

  it("stays quiet inside the grace window", () => {
    const d = decideStaleDraftAlert({ ...base, ss4Status: "draft", ss4UpdatedAt: daysAgo(1) })
    expect(d.alert).toBe(false)
  })

  it("does not alert when the SS-4 is already with the client or signed", () => {
    for (const status of ["awaiting_signature", "signed", "submitted", "done"]) {
      const d = decideStaleDraftAlert({ ...base, ss4Status: status, ss4UpdatedAt: daysAgo(10) })
      expect(d.alert).toBe(false)
    }
  })

  it("throttles repeat alerts", () => {
    const d = decideStaleDraftAlert({ ...base, ss4Status: "draft", ss4UpdatedAt: daysAgo(10), lastAlertAt: daysAgo(STAFF_ALERT_REPEAT_DAYS - 1) })
    expect(d.alert).toBe(false)
    const d2 = decideStaleDraftAlert({ ...base, ss4Status: "draft", ss4UpdatedAt: daysAgo(10), lastAlertAt: daysAgo(STAFF_ALERT_REPEAT_DAYS + 1) })
    expect(d2.alert).toBe(true)
  })

  it("ignores SDs at other stages", () => {
    const d = decideStaleDraftAlert({ ...base, sdStage: "SS-4 Signed", ss4Status: "draft", ss4UpdatedAt: daysAgo(10) })
    expect(d.alert).toBe(false)
  })
})
