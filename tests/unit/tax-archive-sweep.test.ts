import { describe, it, expect } from "vitest"
import {
  decideArchiveSweep,
  attemptsOf,
  alreadyAlerted,
  ARCHIVE_SWEEP_CUTOFF_ISO,
  ARCHIVE_SWEEP_MAX_ATTEMPTS,
  ARCHIVE_SWEEP_GRACE_MINUTES,
  ARCHIVE_SWEEP_ALERTED_KEY,
  type ArchiveSweepRow,
} from "@/lib/tax/archive-sweep"

const NOW = new Date("2026-08-01T12:00:00Z")
const wellBefore = new Date(NOW.getTime() - 60 * 60_000).toISOString() // 1h ago (past grace)

function row(over: Partial<ArchiveSweepRow>): ArchiveSweepRow {
  return {
    id: "s1",
    account_id: "a1",
    status: "reviewed",
    review_status: null,
    created_at: wellBefore,
    drive_archived_at: null,
    drive_archive_meta: {},
    ...over,
  }
}

describe("decideArchiveSweep", () => {
  it("enqueues a real, un-archived, aged submission with attempts under the cap", () => {
    expect(decideArchiveSweep(row({}), NOW)).toBe("enqueue")
  })

  it("skips an already-archived row", () => {
    expect(decideArchiveSweep(row({ drive_archived_at: "2026-07-30T00:00:00Z" }), NOW)).toBe("skip")
  })

  it("skips a contact-scoped submission with no account", () => {
    expect(decideArchiveSweep(row({ account_id: null }), NOW)).toBe("skip")
  })

  it("skips an empty pending shell (not a real submission)", () => {
    expect(decideArchiveSweep(row({ status: "pending", review_status: null }), NOW)).toBe("skip")
  })

  it("FORWARD-ONLY: skips anything created before the cutoff (no mass backfill)", () => {
    const before = new Date(Date.parse(ARCHIVE_SWEEP_CUTOFF_ISO) - 1000).toISOString()
    expect(decideArchiveSweep(row({ created_at: before }), NOW)).toBe("skip")
  })

  it("GRACE: skips a submission younger than the grace window (a live job may be running)", () => {
    const fresh = new Date(NOW.getTime() - (ARCHIVE_SWEEP_GRACE_MINUTES - 5) * 60_000).toISOString()
    expect(decideArchiveSweep(row({ created_at: fresh }), NOW)).toBe("skip")
  })

  it("alerts once when attempts are exhausted and not yet alerted", () => {
    expect(decideArchiveSweep(row({ drive_archive_meta: { attempts: ARCHIVE_SWEEP_MAX_ATTEMPTS } }), NOW)).toBe("alert")
  })

  it("does NOT re-alert an already-alerted stuck row (no storm)", () => {
    expect(decideArchiveSweep(row({ drive_archive_meta: { attempts: ARCHIVE_SWEEP_MAX_ATTEMPTS, [ARCHIVE_SWEEP_ALERTED_KEY]: true } }), NOW)).toBe("skip")
  })

  it("a review-loop submission (review_status set) counts as real even if status is odd", () => {
    expect(decideArchiveSweep(row({ status: "pending", review_status: "resubmitted" }), NOW)).toBe("enqueue")
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
    expect(alreadyAlerted({ [ARCHIVE_SWEEP_ALERTED_KEY]: true })).toBe(true)
    expect(alreadyAlerted({})).toBe(false)
  })
})
