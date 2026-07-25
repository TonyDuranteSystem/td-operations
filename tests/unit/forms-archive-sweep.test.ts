import { describe, it, expect } from "vitest"
import {
  decideFormArchiveSweep,
  attemptsOf,
  alreadyAlerted,
  FORM_ARCHIVE_SWEEP_CUTOFF_ISO,
  FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS,
  FORM_ARCHIVE_SWEEP_GRACE_MINUTES,
  FORM_ARCHIVE_SWEEP_ALERTED_KEY,
} from "@/lib/forms/archive-sweep"
import type { ArchiveRecipe } from "@/lib/forms/archive-registry"

const NOW = new Date("2026-08-01T12:00:00Z")
const wellBefore = new Date(NOW.getTime() - 60 * 60_000).toISOString() // 1h ago (past grace)

// A minimal stub recipe: "real" = status completed/reviewed (like banking). Only
// isReal is exercised by the sweep decision; the rest is unused here.
const stubRecipe: ArchiveRecipe = {
  formType: "banking",
  table: "banking_submissions",
  selectColumns: "id",
  isReal: (row) => row.status === "completed" || row.status === "reviewed",
  resolvePlan: async () => { throw new Error("not used in sweep-decision tests") },
}

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s1",
    status: "completed",
    created_at: wellBefore,
    drive_archived_at: null,
    drive_archive_meta: {},
    ...over,
  }
}

describe("decideFormArchiveSweep", () => {
  it("enqueues a real, un-archived, aged submission with attempts under the cap", () => {
    expect(decideFormArchiveSweep(row({}), stubRecipe, NOW)).toBe("enqueue")
  })

  it("skips an already-archived row", () => {
    expect(decideFormArchiveSweep(row({ drive_archived_at: "2026-07-30T00:00:00Z" }), stubRecipe, NOW)).toBe("skip")
  })

  it("skips an empty pending shell (not a real submission)", () => {
    expect(decideFormArchiveSweep(row({ status: "pending" }), stubRecipe, NOW)).toBe("skip")
  })

  it("does NOT require an account_id (unlike the tax sweep) — a no-account real row still enqueues", () => {
    // formation etc. carry no account; the failing job/alert is the loud path, not a silent skip here.
    expect(decideFormArchiveSweep(row({ account_id: null }), stubRecipe, NOW)).toBe("enqueue")
  })

  it("FORWARD-ONLY: skips anything created before the cutoff (no mass backfill)", () => {
    const before = new Date(Date.parse(FORM_ARCHIVE_SWEEP_CUTOFF_ISO) - 1000).toISOString()
    expect(decideFormArchiveSweep(row({ created_at: before }), stubRecipe, NOW)).toBe("skip")
  })

  it("GRACE: skips a submission younger than the grace window (a live job may be running)", () => {
    const fresh = new Date(NOW.getTime() - (FORM_ARCHIVE_SWEEP_GRACE_MINUTES - 5) * 60_000).toISOString()
    expect(decideFormArchiveSweep(row({ created_at: fresh }), stubRecipe, NOW)).toBe("skip")
  })

  it("skips a row with an unparseable created_at", () => {
    expect(decideFormArchiveSweep(row({ created_at: "not-a-date" }), stubRecipe, NOW)).toBe("skip")
  })

  it("alerts once when attempts are exhausted and not yet alerted", () => {
    expect(decideFormArchiveSweep(row({ drive_archive_meta: { attempts: FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS } }), stubRecipe, NOW)).toBe("alert")
  })

  it("does NOT re-alert an already-alerted stuck row (no storm)", () => {
    expect(
      decideFormArchiveSweep(
        row({ drive_archive_meta: { attempts: FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS, [FORM_ARCHIVE_SWEEP_ALERTED_KEY]: true } }),
        stubRecipe,
        NOW,
      ),
    ).toBe("skip")
  })

  it("counts a 'reviewed' banking row as real", () => {
    expect(decideFormArchiveSweep(row({ status: "reviewed" }), stubRecipe, NOW)).toBe("enqueue")
  })
})

describe("attemptsOf / alreadyAlerted", () => {
  it("reads a positive integer attempt count, else 0", () => {
    expect(attemptsOf({ attempts: 3 })).toBe(3)
    expect(attemptsOf({})).toBe(0)
    expect(attemptsOf(null)).toBe(0)
    expect(attemptsOf({ attempts: -1 })).toBe(0)
  })
  it("detects the alerted flag", () => {
    expect(alreadyAlerted({ [FORM_ARCHIVE_SWEEP_ALERTED_KEY]: true })).toBe(true)
    expect(alreadyAlerted({})).toBe(false)
  })
})
