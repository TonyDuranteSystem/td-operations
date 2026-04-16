/**
 * P2.10 — cron coverage helper tests.
 *
 * Covers: cron-expression interval parser, stale detection, zero-findings
 * streak detection (by day), and a completeness guard that pairs
 * SCHEDULED_CRONS with the live vercel.json so drift fails a test.
 */

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  SCHEDULED_CRONS,
  expectedIntervalMs,
  isStale,
  zeroFindingsStreak,
  zeroFindingsStreakDays,
} from "@/lib/cron-coverage"

describe("expectedIntervalMs", () => {
  it("*/5 * * * *  → 5 minutes", () => {
    expect(expectedIntervalMs("*/5 * * * *")).toBe(5 * 60_000)
  })

  it("*/15 * * * *  → 15 minutes", () => {
    expect(expectedIntervalMs("*/15 * * * *")).toBe(15 * 60_000)
  })

  it("0 */6 * * *  → 6 hours", () => {
    expect(expectedIntervalMs("0 */6 * * *")).toBe(6 * 60 * 60_000)
  })

  it("0 */2 * * *  → 2 hours", () => {
    expect(expectedIntervalMs("0 */2 * * *")).toBe(2 * 60 * 60_000)
  })

  it("0 */1 * * *  → 1 hour", () => {
    expect(expectedIntervalMs("0 */1 * * *")).toBe(60 * 60_000)
  })

  it("0 9 * * *  → 1 day", () => {
    expect(expectedIntervalMs("0 9 * * *")).toBe(24 * 60 * 60_000)
  })

  it("17 9 * * *  → 1 day", () => {
    expect(expectedIntervalMs("17 9 * * *")).toBe(24 * 60 * 60_000)
  })

  it("0 12 * * 1  → 7 days (weekly Monday)", () => {
    expect(expectedIntervalMs("0 12 * * 1")).toBe(7 * 24 * 60 * 60_000)
  })

  it("0 10 1 * *  → 31 days (monthly)", () => {
    expect(expectedIntervalMs("0 10 1 * *")).toBe(31 * 24 * 60 * 60_000)
  })

  it("returns null for unrecognized expressions", () => {
    expect(expectedIntervalMs("0,30 9-17 * * 1-5")).toBeNull()
    expect(expectedIntervalMs("not a cron expression")).toBeNull()
    expect(expectedIntervalMs("* * *")).toBeNull()
  })
})

describe("isStale", () => {
  const now = new Date("2026-04-16T20:00:00Z").getTime()

  it("never-run scheduled cron is stale", () => {
    expect(isStale(null, "0 */6 * * *", now)).toBe(true)
  })

  it("cron with unknown schedule is never flagged", () => {
    expect(isStale(null, "0,30 9-17 * * 1-5", now)).toBe(false)
  })

  it("last run within 2× interval is NOT stale", () => {
    // 6-hour cron, last ran 11h ago: within 2× = 12h. Not stale.
    const lastRun = new Date(now - 11 * 60 * 60_000).toISOString()
    expect(isStale(lastRun, "0 */6 * * *", now)).toBe(false)
  })

  it("last run past 2× interval IS stale", () => {
    // 6-hour cron, last ran 13h ago: past 2× = 12h. Stale.
    const lastRun = new Date(now - 13 * 60 * 60_000).toISOString()
    expect(isStale(lastRun, "0 */6 * * *", now)).toBe(true)
  })

  it("daily cron stale after >48h", () => {
    const lastRun = new Date(now - 50 * 60 * 60_000).toISOString()
    expect(isStale(lastRun, "0 9 * * *", now)).toBe(true)
  })

  it("daily cron fresh after 12h", () => {
    const lastRun = new Date(now - 12 * 60 * 60_000).toISOString()
    expect(isStale(lastRun, "0 9 * * *", now)).toBe(false)
  })
})

describe("zeroFindingsStreak", () => {
  const zero = (iso: string) => ({ status: "success", executed_at: iso, details: { total_findings: 0 } })
  const withFindings = (iso: string, n: number) => ({ status: "success", executed_at: iso, details: { total_findings: n } })
  const errored = (iso: string) => ({ status: "error", executed_at: iso, details: null })

  it("empty input → 0", () => {
    expect(zeroFindingsStreak([])).toBe(0)
  })

  it("counts contiguous zero-findings runs at the head", () => {
    const rows = [
      zero("2026-04-16T07:00Z"),
      zero("2026-04-15T07:00Z"),
      zero("2026-04-14T07:00Z"),
      withFindings("2026-04-13T07:00Z", 3),
      zero("2026-04-12T07:00Z"),
    ]
    // Streak only counts until the first non-zero run (3 findings on 04-13).
    expect(zeroFindingsStreak(rows)).toBe(3)
  })

  it("breaks on error row", () => {
    const rows = [
      zero("2026-04-16T07:00Z"),
      errored("2026-04-15T07:00Z"),
      zero("2026-04-14T07:00Z"),
    ]
    expect(zeroFindingsStreak(rows)).toBe(1)
  })

  it("breaks on missing details.total_findings", () => {
    const rows = [
      zero("2026-04-16T07:00Z"),
      { status: "success", executed_at: "2026-04-15T07:00Z", details: {} },
    ]
    expect(zeroFindingsStreak(rows)).toBe(1)
  })
})

describe("zeroFindingsStreakDays", () => {
  const zero = (iso: string) => ({ status: "success", executed_at: iso, details: { total_findings: 0 } })

  it("counts DISTINCT UTC days in the streak, not runs", () => {
    // 6 hourly runs across 2 calendar days → 2 days, not 6.
    const rows = [
      zero("2026-04-16T20:00:00Z"),
      zero("2026-04-16T14:00:00Z"),
      zero("2026-04-16T08:00:00Z"),
      zero("2026-04-15T20:00:00Z"),
      zero("2026-04-15T14:00:00Z"),
      zero("2026-04-15T08:00:00Z"),
    ]
    expect(zeroFindingsStreakDays(rows)).toBe(2)
  })

  it("5 days of zero findings → 5 (threshold boundary)", () => {
    const rows = ["16", "15", "14", "13", "12"].map(d => zero(`2026-04-${d}T07:00:00Z`))
    expect(zeroFindingsStreakDays(rows)).toBe(5)
  })

  it("returns 0 when head is not zero-findings", () => {
    const rows = [
      { status: "success", executed_at: "2026-04-16T07:00Z", details: { total_findings: 3 } },
      zero("2026-04-15T07:00Z"),
    ]
    expect(zeroFindingsStreakDays(rows)).toBe(0)
  })
})

describe("SCHEDULED_CRONS completeness", () => {
  // Drift guard: vercel.json is the operational source of truth for cron
  // schedules. If someone adds/removes/renames a cron there and forgets to
  // update SCHEDULED_CRONS, this test fails. Pairing this with a single-
  // file update keeps the coverage audit honest.
  it("matches vercel.json exactly", () => {
    const vercelJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons: Array<{ path: string; schedule: string }> }

    // Strip querystrings (e.g. "/api/cron/mercury-sync?days=7" → "/api/cron/mercury-sync").
    const vercelMap: Record<string, string> = {}
    for (const c of vercelJson.crons) {
      const path = c.path.split("?")[0]
      if (path === "/api/cron/cron-coverage-audit") continue // the auditor itself is out of scope
      vercelMap[path] = c.schedule
    }

    expect(SCHEDULED_CRONS).toEqual(vercelMap)
  })
})
