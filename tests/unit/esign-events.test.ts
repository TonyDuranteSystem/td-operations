/**
 * The audit-event vocabulary. This list is gated against production's CHECK
 * constraint (lib/db-contract.ts), and it exists because a value the database
 * rejects fails SILENTLY — supabase-js returns the error rather than throwing,
 * and every historic call site discarded it. Production ran for over a month
 * writing 'expired' events that were rejected and thrown away.
 */

import { describe, it, expect } from "vitest"
import { EVENT_TYPES, REMINDER_SOURCE_AUTO, REMINDER_SOURCE_MANUAL } from "@/lib/esign/events"

describe("EVENT_TYPES", () => {
  it("carries the types the code actually writes", () => {
    for (const t of [
      "created", "sent", "viewed", "signed", "declined", "completed", "voided",
      "reminder_sent", "consent_accepted", "expired", "reopened", "deadline_changed",
    ]) {
      expect(EVENT_TYPES).toContain(t)
    }
  })

  it("has no duplicates — a duplicate would pass the gate but muddle counting", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })

  it("keeps manual and automatic reminders distinguishable WITHOUT separate event types", () => {
    // A separate 'reminder_sent_manual' type would be counted by the automatic
    // cadence cap, so two staff clicks would silently switch automatic nudges
    // off for that signer. The origin lives in metadata instead.
    expect(REMINDER_SOURCE_AUTO).not.toBe(REMINDER_SOURCE_MANUAL)
    expect(EVENT_TYPES).not.toContain("reminder_sent_manual")
    expect(EVENT_TYPES.filter(t => t.startsWith("reminder"))).toEqual(["reminder_sent"])
  })
})
