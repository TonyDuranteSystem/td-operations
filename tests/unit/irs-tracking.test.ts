/**
 * Pure-logic tests for the IRS shipment tracking check (app/api/cron/irs-tracking-check).
 */

import { describe, expect, it } from "vitest"
import {
  decideCheckOutcome,
  isStuck,
  buildTrackingAlertEmail,
  NO_MATCH_ALERT_THRESHOLD,
  DELIVERED_CONFIRM_THRESHOLD,
  DELIVERED_DATE_GRACE_CHECKS,
  STUCK_ALERT_THRESHOLD_DAYS,
  type TrackingRow,
} from "@/lib/operations/irs-tracking"

const NOW = new Date("2026-09-09T12:00:00Z")

function row(overrides: Partial<TrackingRow> = {}): TrackingRow {
  return {
    tracking_number: "1Z999AA10123456784",
    consecutive_delivered_checks: 0,
    consecutive_unmatched_checks: 0,
    delivered_at: null,
    no_match_alerted_at: null,
    stuck_alerted_at: null,
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  }
}

describe("decideCheckOutcome — no match", () => {
  it("increments the unmatched streak and resets the delivered streak", () => {
    const d = decideCheckOutcome(row({ consecutive_delivered_checks: 1, consecutive_unmatched_checks: 2 }), { found: false }, NOW)
    expect(d.patch.status).toBe("not_found")
    expect(d.patch.consecutive_unmatched_checks).toBe(3)
    expect(d.patch.consecutive_delivered_checks).toBe(0)
    expect(d.confirmDelivered).toBe(false)
  })

  it("raises the no-match alert exactly when the threshold is first crossed", () => {
    const justUnder = decideCheckOutcome(row({ consecutive_unmatched_checks: NO_MATCH_ALERT_THRESHOLD - 2 }), { found: false }, NOW)
    expect(justUnder.raiseNoMatchAlert).toBe(false)

    const crossing = decideCheckOutcome(row({ consecutive_unmatched_checks: NO_MATCH_ALERT_THRESHOLD - 1 }), { found: false }, NOW)
    expect(crossing.patch.consecutive_unmatched_checks).toBe(NO_MATCH_ALERT_THRESHOLD)
    expect(crossing.raiseNoMatchAlert).toBe(true)
  })

  it("never re-raises once already alerted, even well past the threshold", () => {
    const d = decideCheckOutcome(
      row({ consecutive_unmatched_checks: NO_MATCH_ALERT_THRESHOLD + 10, no_match_alerted_at: "2026-08-15T00:00:00Z" }),
      { found: false },
      NOW,
    )
    expect(d.raiseNoMatchAlert).toBe(false)
  })
})

describe("decideCheckOutcome — matched, not delivered", () => {
  it("resets both streaks and caches the status + ship date", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: 1, consecutive_unmatched_checks: 3 }),
      { found: true, status: "in_transit", shipDate: "2026-09-01", actualDeliveryDate: null },
      NOW,
    )
    expect(d.patch).toEqual({
      status: "in_transit",
      checked_at: NOW.toISOString(),
      matched_ship_date: "2026-09-01",
      consecutive_delivered_checks: 0,
      consecutive_unmatched_checks: 0,
    })
    expect(d.confirmDelivered).toBe(false)
    expect(d.deliveredAt).toBeNull()
    expect(d.raiseNoMatchAlert).toBe(false)
  })

  it("a stale 'delivered' streak does not survive an intervening non-delivered read", () => {
    // Day 1: delivered (count -> 1, not yet confirmed). Day 2: reverts to in_transit.
    const day2 = decideCheckOutcome(row({ consecutive_delivered_checks: 1 }), { found: true, status: "in_transit", shipDate: null, actualDeliveryDate: null }, NOW)
    expect(day2.patch.consecutive_delivered_checks).toBe(0)
    // Day 3: delivered again — must start counting from 0, not resume from the day-1 streak.
    const day3 = decideCheckOutcome(
      row({ consecutive_delivered_checks: day2.patch.consecutive_delivered_checks }),
      { found: true, status: "delivered", shipDate: null, actualDeliveryDate: null },
      NOW,
    )
    expect(day3.patch.consecutive_delivered_checks).toBe(1)
    expect(day3.confirmDelivered).toBe(false)
  })

  it("treats a matched label with tracking_status 'error' as matched-not-delivered, not as no-match", () => {
    const d = decideCheckOutcome(row(), { found: true, status: "error", shipDate: null, actualDeliveryDate: null }, NOW)
    expect(d.patch.status).toBe("error")
    expect(d.patch.consecutive_unmatched_checks).toBe(0)
    expect(d.raiseNoMatchAlert).toBe(false)
  })
})

describe("decideCheckOutcome — matched, delivered", () => {
  it("does not confirm on the first delivered reading, even with a real date already in hand", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: 0 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: "2026-09-04T10:00:00Z" },
      NOW,
    )
    expect(d.patch.consecutive_delivered_checks).toBe(1)
    expect(d.confirmDelivered).toBe(false)
    expect(d.deliveredAt).toBeNull()
  })

  it("confirms on the second CONSECUTIVE delivered reading, using the carrier's real date — never today's date", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: DELIVERED_CONFIRM_THRESHOLD - 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: "2026-08-17T12:59:00Z" },
      NOW,
    )
    expect(d.patch.consecutive_delivered_checks).toBe(DELIVERED_CONFIRM_THRESHOLD)
    expect(d.confirmDelivered).toBe(true)
    expect(d.deliveredAt).toBe("2026-08-17T12:59:00Z")
    expect(d.deliveredAt).not.toBe(NOW.toISOString())
  })

  it("WAITS rather than guessing when the threshold is reached but the real date isn't available yet", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: DELIVERED_CONFIRM_THRESHOLD - 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: null },
      NOW,
    )
    // The streak still advances normally — only confirmation itself waits.
    expect(d.patch.consecutive_delivered_checks).toBe(DELIVERED_CONFIRM_THRESHOLD)
    expect(d.confirmDelivered).toBe(false)
    expect(d.deliveredAt).toBeNull()
  })

  it("confirms with the real date as soon as it becomes available, even several checks after the threshold was first reached", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: DELIVERED_CONFIRM_THRESHOLD + 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: "2026-08-17T12:59:00Z" },
      NOW,
    )
    expect(d.confirmDelivered).toBe(true)
    expect(d.deliveredAt).toBe("2026-08-17T12:59:00Z")
  })

  it("does NOT yet fall back to today's date one check before the grace period expires", () => {
    const justUnder = DELIVERED_CONFIRM_THRESHOLD + DELIVERED_DATE_GRACE_CHECKS - 1
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: justUnder - 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: null },
      NOW,
    )
    expect(d.patch.consecutive_delivered_checks).toBe(justUnder)
    expect(d.confirmDelivered).toBe(false)
    expect(d.deliveredAt).toBeNull()
  })

  it("falls back to today's date as a last resort once the grace period is fully exhausted with no real date ever appearing", () => {
    const atGraceLimit = DELIVERED_CONFIRM_THRESHOLD + DELIVERED_DATE_GRACE_CHECKS
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: atGraceLimit - 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: null },
      NOW,
    )
    expect(d.patch.consecutive_delivered_checks).toBe(atGraceLimit)
    expect(d.confirmDelivered).toBe(true)
    expect(d.deliveredAt).toBe(NOW.toISOString())
  })

  it("still prefers the real date over today's fallback even once the grace period has expired", () => {
    const atGraceLimit = DELIVERED_CONFIRM_THRESHOLD + DELIVERED_DATE_GRACE_CHECKS
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: atGraceLimit - 1 }),
      { found: true, status: "delivered", shipDate: "2026-09-05", actualDeliveryDate: "2026-08-17T12:59:00Z" },
      NOW,
    )
    expect(d.confirmDelivered).toBe(true)
    expect(d.deliveredAt).toBe("2026-08-17T12:59:00Z")
  })

  it("never re-confirms a case that already has delivered_at set, real date or not", () => {
    const d = decideCheckOutcome(
      row({ consecutive_delivered_checks: 5, delivered_at: "2026-09-01T00:00:00Z" }),
      { found: true, status: "delivered", shipDate: null, actualDeliveryDate: "2026-08-17T12:59:00Z" },
      NOW,
    )
    expect(d.confirmDelivered).toBe(false)
    expect(d.deliveredAt).toBeNull()
  })

  it("deliveredAt is always null when confirmDelivered is false, and always a valid ISO string when true", () => {
    const scenarios: Array<[TrackingRow, Parameters<typeof decideCheckOutcome>[1]]> = [
      [row({ consecutive_delivered_checks: 0 }), { found: true, status: "delivered", shipDate: null, actualDeliveryDate: null }],
      [row({ consecutive_delivered_checks: DELIVERED_CONFIRM_THRESHOLD - 1 }), { found: true, status: "delivered", shipDate: null, actualDeliveryDate: null }],
      [row({ consecutive_delivered_checks: DELIVERED_CONFIRM_THRESHOLD - 1 }), { found: true, status: "delivered", shipDate: null, actualDeliveryDate: "2026-08-17T12:59:00Z" }],
    ]
    for (const [r, lookup] of scenarios) {
      const d = decideCheckOutcome(r, lookup, NOW)
      if (d.confirmDelivered) {
        expect(d.deliveredAt).not.toBeNull()
        expect(() => new Date(d.deliveredAt as string).toISOString()).not.toThrow()
      } else {
        expect(d.deliveredAt).toBeNull()
      }
    }
  })
})

describe("isStuck", () => {
  it("is false while delivered", () => {
    expect(isStuck({ created_at: "2020-01-01T00:00:00Z", delivered_at: "2026-01-01T00:00:00Z", stuck_alerted_at: null }, NOW)).toBe(false)
  })

  it("is false once already alerted, no matter how old", () => {
    expect(isStuck({ created_at: "2020-01-01T00:00:00Z", delivered_at: null, stuck_alerted_at: "2026-01-01T00:00:00Z" }, NOW)).toBe(false)
  })

  it("is false just under the threshold", () => {
    const created = new Date(NOW.getTime() - (STUCK_ALERT_THRESHOLD_DAYS - 1) * 86400000).toISOString()
    expect(isStuck({ created_at: created, delivered_at: null, stuck_alerted_at: null }, NOW)).toBe(false)
  })

  it("is true once past the threshold", () => {
    const created = new Date(NOW.getTime() - (STUCK_ALERT_THRESHOLD_DAYS + 1) * 86400000).toISOString()
    expect(isStuck({ created_at: created, delivered_at: null, stuck_alerted_at: null }, NOW)).toBe(true)
  })

  it("anchors on created_at, not any other timestamp — a fresh case is never stuck", () => {
    expect(isStuck({ created_at: NOW.toISOString(), delivered_at: null, stuck_alerted_at: null }, NOW)).toBe(false)
  })
})

describe("buildTrackingAlertEmail", () => {
  function decode(raw: string) {
    return Buffer.from(raw, "base64url").toString("utf-8")
  }

  it("RFC 2047-encodes the subject rather than embedding it raw", () => {
    const { raw } = buildTrackingAlertEmail({ reason: "no_match", companyName: "Acme LLC", trackingNumber: "1Z999", serviceDeliveryId: "sd-1" })
    const text = decode(raw)
    const subjectLine = text.split("\r\n").find((l) => l.startsWith("Subject:"))
    expect(subjectLine).toMatch(/^Subject: =\?utf-8\?B\?/)
    const encoded = subjectLine!.replace("Subject: =?utf-8?B?", "").replace("?=", "")
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toContain("Acme LLC")
  })

  it("always addresses the shared support inbox, matching the fax-confirmation precedent", () => {
    const { raw } = buildTrackingAlertEmail({ reason: "stuck", companyName: "Acme LLC", trackingNumber: "1Z999", serviceDeliveryId: "sd-1" })
    expect(decode(raw)).toContain("To: support@tonydurante.us")
  })

  it("strips CR/LF from interpolated values so they cannot inject an extra header line", () => {
    const { raw } = buildTrackingAlertEmail({
      reason: "no_match",
      companyName: "Evil Co\r\nBcc: attacker@example.com",
      trackingNumber: "1Z999",
      serviceDeliveryId: "sd-1",
    })
    const text = decode(raw)
    // The injected text must stay inline on the Company: line, never become its own
    // header line — that's the actual exploit this sanitizer exists to prevent.
    const lines = text.split("\r\n")
    expect(lines.some((l) => l.startsWith("Bcc:"))).toBe(false)
    expect(lines.filter((l) => l.startsWith("To:"))).toHaveLength(1)
    expect(text).toContain("Evil Co  Bcc: attacker@example.com")
  })

  it("distinguishes the two alert reasons in the body", () => {
    const noMatch = decode(buildTrackingAlertEmail({ reason: "no_match", companyName: "Acme", trackingNumber: "X", serviceDeliveryId: "sd-1" }).raw)
    const stuck = decode(buildTrackingAlertEmail({ reason: "stuck", companyName: "Acme", trackingNumber: "X", serviceDeliveryId: "sd-1" }).raw)
    expect(noMatch).toMatch(/no match/i)
    expect(stuck).toMatch(/150/)
    expect(noMatch).not.toBe(stuck)
  })
})
