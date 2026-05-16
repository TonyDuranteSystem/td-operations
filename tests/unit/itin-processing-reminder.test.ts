/**
 * Pure-logic tests for the IRS-processing reminder eligibility rules.
 *
 * Time-traveled by passing an explicit `now` to decideReminder so we don't
 * have to mock Date.
 */

import { describe, expect, it } from "vitest"
import { decideReminder, buildReminderMessage } from "@/lib/tasks/itin-processing-reminder"

const DAY = 24 * 60 * 60 * 1000

function isoMinusDays(days: number, from: Date): string {
  return new Date(from.getTime() - days * DAY).toISOString()
}

describe("decideReminder", () => {
  const now = new Date("2026-06-01T12:00:00Z")

  it("skips tasks younger than 28 days", () => {
    const decision = decideReminder(
      { id: "t1", created_at: isoMinusDays(14, now), task_meta: null },
      now,
    )
    expect(decision).toEqual({ send: false, reason: "too_recent" })
  })

  it("sends when task is exactly 28 days old and never reminded", () => {
    const decision = decideReminder(
      { id: "t1", created_at: isoMinusDays(28, now), task_meta: null },
      now,
    )
    expect(decision.send).toBe(true)
    if (decision.send) {
      expect(decision.weeks_since_start).toBe(4)
      expect(decision.previously_sent_at).toBeNull()
    }
  })

  it("sends when task is 8 weeks old and never reminded", () => {
    const decision = decideReminder(
      { id: "t1", created_at: isoMinusDays(56, now), task_meta: null },
      now,
    )
    expect(decision.send).toBe(true)
    if (decision.send) expect(decision.weeks_since_start).toBe(8)
  })

  it("skips when a reminder was sent within the last 4 weeks", () => {
    const decision = decideReminder(
      {
        id: "t1",
        created_at: isoMinusDays(60, now),
        task_meta: { last_irs_reminder_at: isoMinusDays(10, now) },
      },
      now,
    )
    expect(decision).toEqual({ send: false, reason: "already_reminded_recently" })
  })

  it("sends again when the last reminder was more than 4 weeks ago", () => {
    const decision = decideReminder(
      {
        id: "t1",
        created_at: isoMinusDays(90, now),
        task_meta: { last_irs_reminder_at: isoMinusDays(30, now) },
      },
      now,
    )
    expect(decision.send).toBe(true)
    if (decision.send) expect(decision.previously_sent_at).toBeTruthy()
  })

  it("stops reminding past the 16-week max window", () => {
    const decision = decideReminder(
      {
        id: "t1",
        created_at: isoMinusDays(17 * 7, now),
        task_meta: { last_irs_reminder_at: isoMinusDays(30, now) },
      },
      now,
    )
    expect(decision).toEqual({ send: false, reason: "max_window_exceeded" })
  })

  it("returns invalid_dates for an unparseable created_at", () => {
    const decision = decideReminder({ id: "t1", created_at: "not-a-date", task_meta: null }, now)
    expect(decision).toEqual({ send: false, reason: "invalid_dates" })
  })

  it("ignores a corrupt last_irs_reminder_at and still sends", () => {
    const decision = decideReminder(
      {
        id: "t1",
        created_at: isoMinusDays(60, now),
        task_meta: { last_irs_reminder_at: "bad-date-string" },
      },
      now,
    )
    expect(decision.send).toBe(true)
  })
})

describe("buildReminderMessage", () => {
  it("returns English message in EN", () => {
    const msg = buildReminderMessage({ first_name: "Maria", language: "en", weeks_since_start: 6 })
    expect(msg).toMatch(/Hi Maria/)
    expect(msg).toMatch(/6 weeks ago/)
    expect(msg).toMatch(/7–11 weeks/)
  })

  it("returns Italian message in IT", () => {
    const msg = buildReminderMessage({ first_name: "Marco", language: "it", weeks_since_start: 5 })
    expect(msg).toMatch(/Ciao Marco/)
    expect(msg).toMatch(/5 settimane fa/)
    expect(msg).toMatch(/7–11 settimane/)
  })
})
