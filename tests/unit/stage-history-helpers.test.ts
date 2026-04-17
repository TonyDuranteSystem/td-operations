/**
 * P3.4 #4 — stage history helpers unit tests.
 *
 * Covers: normalizeStageHistory (input validation, sort order,
 * malformed-entry filtering) and formatRelativeTime (buckets: minutes,
 * hours, days, weeks, months, years).
 */

import { describe, it, expect } from "vitest"
import { normalizeStageHistory, formatRelativeTime } from "@/lib/stage-history-helpers"

describe("normalizeStageHistory", () => {
  it("returns empty array for non-array input", () => {
    expect(normalizeStageHistory(null)).toEqual([])
    expect(normalizeStageHistory(undefined)).toEqual([])
    expect(normalizeStageHistory({})).toEqual([])
    expect(normalizeStageHistory("string")).toEqual([])
  })

  it("filters out entries without a to_stage", () => {
    const raw = [
      { to_stage: "Paid", advanced_at: "2026-04-01T10:00:00Z" },
      { advanced_at: "2026-04-02T10:00:00Z" }, // no to_stage
      { to_stage: "", advanced_at: "2026-04-03T10:00:00Z" }, // empty
      null,
      "not an object",
      { to_stage: "Active" },
    ]
    const result = normalizeStageHistory(raw)
    expect(result.map(r => r.to_stage)).toEqual(["Paid", "Active"])
  })

  it("sorts entries newest-first by advanced_at", () => {
    const raw = [
      { to_stage: "A", advanced_at: "2026-01-01T00:00:00Z" },
      { to_stage: "B", advanced_at: "2026-03-15T00:00:00Z" },
      { to_stage: "C", advanced_at: "2026-02-01T00:00:00Z" },
    ]
    const result = normalizeStageHistory(raw)
    expect(result.map(r => r.to_stage)).toEqual(["B", "C", "A"])
  })

  it("sorts entries without a timestamp last", () => {
    const raw = [
      { to_stage: "A", advanced_at: "2026-01-01T00:00:00Z" },
      { to_stage: "NoTime" },
      { to_stage: "B", advanced_at: "2026-02-01T00:00:00Z" },
    ]
    const result = normalizeStageHistory(raw)
    expect(result.map(r => r.to_stage)).toEqual(["B", "A", "NoTime"])
  })

  it("preserves all canonical keys when present", () => {
    const raw = [
      {
        to_stage: "Active",
        to_order: 3,
        from_stage: "Pending",
        from_order: 2,
        advanced_at: "2026-04-01T10:00:00Z",
        actor: "crm-tracker",
        notes: "Moved by Antonio",
      },
    ]
    expect(normalizeStageHistory(raw)).toEqual([
      {
        to_stage: "Active",
        to_order: 3,
        from_stage: "Pending",
        from_order: 2,
        advanced_at: "2026-04-01T10:00:00Z",
        actor: "crm-tracker",
        notes: "Moved by Antonio",
      },
    ])
  })

  it("coerces invalid-typed fields to null", () => {
    const raw = [
      {
        to_stage: "Active",
        to_order: "not-a-number",
        from_stage: 42,
        advanced_at: 1234,
        actor: null,
        notes: { some: "object" },
      },
    ]
    const result = normalizeStageHistory(raw)
    expect(result[0]).toEqual({
      to_stage: "Active",
      to_order: null,
      from_stage: null,
      from_order: null,
      advanced_at: null,
      actor: null,
      notes: null,
    })
  })
})

describe("formatRelativeTime", () => {
  const now = new Date("2026-04-17T12:00:00Z")

  it("returns '—' for null or invalid input", () => {
    expect(formatRelativeTime(null, now)).toBe("—")
    expect(formatRelativeTime("not-a-date", now)).toBe("—")
  })

  it("returns 'just now' for <1 minute ago", () => {
    const iso = new Date(now.getTime() - 30 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("just now")
  })

  it("returns minutes for 1-59 min ago", () => {
    const iso = new Date(now.getTime() - 15 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("15m ago")
  })

  it("returns hours for 1-23 h ago", () => {
    const iso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("3h ago")
  })

  it("returns days for 1-6 d ago", () => {
    const iso = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("4d ago")
  })

  it("returns weeks for 7-34 d ago", () => {
    const iso = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("3w ago")
  })

  it("returns months for 35-365 d ago", () => {
    const iso = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("3mo ago")
  })

  it("returns years for 365+ d ago", () => {
    const iso = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso, now)).toBe("2y ago")
  })
})
