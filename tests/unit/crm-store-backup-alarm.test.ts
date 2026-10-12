import { describe, it, expect } from "vitest"
import { classifyBackupProblems, NEVER_BACKED_UP_AFTER_HOURS } from "@/lib/crm-store/backup-alarm"

const NOW = new Date("2026-10-13T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const base = { counts: {}, sample: [], succeededOwners: new Set<string>(), neverBackedUp: [], now: NOW }

describe("classifyBackupProblems — when the storage backup needs a human", () => {
  it("is quiet when everything is fine", () => {
    expect(classifyBackupProblems(base)).toEqual([])
  })

  it("raises a storage that keeps failing and one with changes waiting too long", () => {
    const p = classifyBackupProblems({ ...base, counts: { owner_failing: 2, owner_late: 1 } })
    expect(p).toHaveLength(2)
    expect(p[0]).toMatch(/2 storage\(s\) have failed/)
    expect(p[1]).toMatch(/waiting for backup for more than 6 hours/)
  })

  it("a missing Drive copy counts only for a storage that was backed up before", () => {
    const sample = [
      { kind: "missing_file", owner_id: "old", file_id: "f1", detail: "a.pdf" },
      { kind: "missing_file", owner_id: "new", file_id: "f2", detail: "b.pdf" },
      { kind: "protected_missing", owner_id: "old", file_id: "f3", detail: "c.pdf" },
    ]
    const p = classifyBackupProblems({ ...base, sample, succeededOwners: new Set(["old"]) })
    expect(p.some((x) => /1\+ live file\(s\) are missing/.test(x))).toBe(true)
    expect(p.some((x) => /1\+ trashed file\(s\) are missing/.test(x))).toBe(true)
    // the brand-new storage alone is NOT a missing-file alarm
    expect(classifyBackupProblems({ ...base, sample: [sample[1]] })).toEqual([])
  })

  it("a file with no saved version is always a problem", () => {
    expect(classifyBackupProblems({ ...base, counts: { no_bytes: 3 } })[0]).toMatch(/3 live file\(s\) have no saved version/)
  })

  it("a storage with files that was never backed up is raised only after the limit", () => {
    const fresh = { owner_id: "a", created_at: hoursAgo(NEVER_BACKED_UP_AFTER_HOURS - 1) }
    const stale = { owner_id: "b", created_at: hoursAgo(NEVER_BACKED_UP_AFTER_HOURS + 1) }
    expect(classifyBackupProblems({ ...base, neverBackedUp: [fresh] })).toEqual([])
    const p = classifyBackupProblems({ ...base, neverBackedUp: [fresh, stale] })
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/1 storage\(s\) with files have still never been backed up/)
  })
})
