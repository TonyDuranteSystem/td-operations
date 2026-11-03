/**
 * Bank application intake — the sweeper of abandoned temporary uploads. The rule is "delete only what provably nothing needs":
 * every case below is a way to be wrong in the dangerous direction (deleting a passport a submitted application still lists as its
 * only copy, or one an applicant is still uploading).
 */
import { describe, it, expect, vi } from "vitest"
import {
  BOFA_SWEEP_GRACE_HOURS,
  BOFA_SWEEP_OPEN_LINK_DAYS,
  decideUploadSweep,
  sweepBofaUploads,
  type SweepObject,
  type SweepRow,
  type UploadSweepBucket,
} from "@/lib/bofa-intake/upload-sweep"

const NOW = new Date("2026-11-10T12:00:00.000Z")
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
const DAY = 24
const obj = (path: string, hoursOld: number): SweepObject => ({ path, created_at: ago(hoursOld) })

const TOK = "tokA"
const P1 = `${TOK}/passport/uuid1-passport.pdf`
const P2 = `${TOK}/passport/uuid2-passport.pdf`
const L1 = `${TOK}/lease/uuid3-lease.pdf`

const completed = (files: unknown): SweepRow => ({ token: TOK, status: "completed", opened_at: ago(10 * DAY), files })
const deletedPaths = (objects: SweepObject[], rows: SweepRow[]) => decideUploadSweep(objects, rows, NOW).deletions.map((d) => d.path)

describe("sweeper — what is never touched", () => {
  it("keeps anything younger than 24 hours, whatever the link looks like", () => {
    const revoked: SweepRow = { token: TOK, status: "revoked" }
    const d = decideUploadSweep([obj(P1, BOFA_SWEEP_GRACE_HOURS - 1)], [revoked], NOW)
    expect(d.deletions).toEqual([])
    expect(d.kept.too_new).toBe(1)
  })

  it("keeps a file the submitted application lists and has no copy of in Storage (archive failed / Save to Storage pending)", () => {
    const rows = [completed([{ key: "passport", name: "p.pdf", path: P1 }])]
    expect(deletedPaths([obj(P1, 5 * DAY)], rows)).toEqual([])
    expect(decideUploadSweep([obj(P1, 5 * DAY)], rows, NOW).kept.still_needed).toBe(1)
  })

  it("keeps a file marked removed but with no Storage id (we cannot prove the copy exists)", () => {
    const rows = [completed([{ key: "passport", name: "p.pdf", path: P1, temp_removed: true }])]
    expect(deletedPaths([obj(P1, 5 * DAY)], rows)).toEqual([])
  })

  it("keeps everything of a submitted application that lists no files at all (we cannot tell what it needs)", () => {
    for (const files of [[], null, undefined, "oops", {}]) {
      const d = decideUploadSweep([obj(P1, 5 * DAY), obj(L1, 5 * DAY)], [completed(files)], NOW)
      expect(d.deletions).toEqual([])
      expect(d.kept.not_understood).toBe(2)
    }
  })

  it("keeps an object whose link has no application row, and reports the token", () => {
    const d = decideUploadSweep([obj("ghost/passport/u-p.pdf", 5 * DAY)], [completed([{ path: P1 }])], NOW)
    expect(d.deletions).toEqual([])
    expect(d.kept.no_row).toBe(1)
    expect(d.tokensWithoutRow).toEqual(["ghost"])
  })

  it("keeps a row in a state it does not know", () => {
    const d = decideUploadSweep([obj(P1, 5 * DAY)], [{ token: TOK, status: "something-new", files: [] }], NOW)
    expect(d.deletions).toEqual([])
    expect(d.kept.not_understood).toBe(1)
  })

  it("keeps objects whose path or age it cannot read", () => {
    const rows: SweepRow[] = [{ token: TOK, status: "revoked" }]
    const odd: SweepObject[] = [
      { path: `${TOK}/passport`, created_at: ago(5 * DAY) }, // too shallow
      { path: `${TOK}/passport/a/b`, created_at: ago(5 * DAY) }, // too deep
      { path: `../passport/x`, created_at: ago(5 * DAY) }, // outside
      { path: `${TOK}//x`, created_at: ago(5 * DAY) }, // empty folder name
      { path: `${TOK}/./x`, created_at: ago(5 * DAY) },
      { path: P1, created_at: null }, // no age
      { path: P2, created_at: "not a date" },
    ]
    const d = decideUploadSweep(odd, rows, NOW)
    expect(d.deletions).toEqual([])
    expect(d.kept.not_understood).toBe(odd.length)
  })

  it("never deletes a link opened less than the cookie lifetime (+ margin) ago, even for old objects", () => {
    const row: SweepRow = { token: TOK, status: "opened", opened_at: ago((BOFA_SWEEP_OPEN_LINK_DAYS - 1) * DAY) }
    const d = decideUploadSweep([obj(P1, 20 * DAY)], [row], NOW)
    expect(d.deletions).toEqual([])
    expect(d.kept.link_in_use).toBe(1)
  })

  it("keeps a recent upload on an old open link (the object itself is the freshest sign of life)", () => {
    const row: SweepRow = { token: TOK, status: "opened", opened_at: ago(50 * DAY) }
    expect(deletedPaths([obj(P1, 3 * DAY)], [row])).toEqual([])
  })

  it("an opened link with no readable opened_at is judged by the object's own age", () => {
    const row: SweepRow = { token: TOK, status: "opened", opened_at: null }
    expect(deletedPaths([obj(P1, 3 * DAY)], [row])).toEqual([])
    expect(deletedPaths([obj(P1, 40 * DAY)], [row])).toEqual([P1])
  })
})

describe("sweeper — what goes", () => {
  it("deletes the redundant temporary copy of a file that is safely in Storage", () => {
    const rows = [completed([{ key: "passport", name: "p.pdf", path: P1, temp_removed: true, store_file_id: "sf1" }])]
    const d = decideUploadSweep([obj(P1, 2 * DAY)], rows, NOW)
    expect(d.deletions).toEqual([{ path: P1, why: "already_in_storage" }])
  })

  it("deletes a swapped-out copy of a submitted application, but not the one it lists", () => {
    const rows = [completed([{ key: "passport", name: "p.pdf", path: P2 }])]
    const d = decideUploadSweep([obj(P1, 2 * DAY), obj(P2, 2 * DAY)], rows, NOW)
    expect(d.deletions).toEqual([{ path: P1, why: "swapped_out_copy" }])
    expect(d.kept.still_needed).toBe(1)
  })

  it("deletes what a revoked link left behind", () => {
    expect(decideUploadSweep([obj(P1, 2 * DAY)], [{ token: TOK, status: "revoked" }], NOW).deletions).toEqual([{ path: P1, why: "link_closed" }])
  })

  it("deletes what a reset link (back to not opened) left behind", () => {
    expect(decideUploadSweep([obj(P1, 2 * DAY)], [{ token: TOK, status: "pending" }], NOW).deletions).toEqual([{ path: P1, why: "link_closed" }])
  })

  it("deletes the uploads of a link opened and abandoned longer ago than the applicant's browser cookie can last", () => {
    const row: SweepRow = { token: TOK, status: "opened", opened_at: ago((BOFA_SWEEP_OPEN_LINK_DAYS + 1) * DAY) }
    expect(decideUploadSweep([obj(P1, (BOFA_SWEEP_OPEN_LINK_DAYS + 1) * DAY)], [row], NOW).deletions).toEqual([{ path: P1, why: "link_expired" }])
  })

  it("the 24-hour line is strict: exactly 24 hours is still kept, a minute older goes", () => {
    const revoked: SweepRow[] = [{ token: TOK, status: "revoked" }]
    expect(deletedPaths([obj(P1, BOFA_SWEEP_GRACE_HOURS)], revoked)).toEqual([])
    expect(deletedPaths([obj(P1, BOFA_SWEEP_GRACE_HOURS + 1 / 60)], revoked)).toEqual([P1])
  })
})

describe("sweeper — the one thing it must never do, over every combination", () => {
  it("never deletes a file a submitted application lists unless Storage has its copy", () => {
    const statuses = ["pending", "opened", "completed", "revoked", "weird"]
    const fileShapes: Record<string, unknown>[] = [
      { path: P1 },
      { path: P1, temp_removed: false },
      { path: P1, temp_removed: true },
      { path: P1, temp_removed: true, store_file_id: "" },
      { path: P1, temp_removed: true, store_file_id: null },
      { path: P1, store_file_id: "sf1" }, // not removed yet: still keep (archive removes it after recording)
    ]
    for (const status of statuses) {
      for (const shape of fileShapes) {
        for (const hours of [1, 30, 24 * 5, 24 * 60]) {
          const row: SweepRow = { token: TOK, status, opened_at: ago(60 * DAY), files: [shape, { path: L1 }] }
          const d = decideUploadSweep([obj(P1, hours)], [row], NOW)
          const gone = d.deletions.some((x) => x.path === P1)
          const proven = shape.temp_removed === true && typeof shape.store_file_id === "string" && shape.store_file_id !== ""
          if (gone) expect(proven && hours >= BOFA_SWEEP_GRACE_HOURS).toBe(true)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// the runner, against a fake bucket
// ---------------------------------------------------------------------------------------------------------------------

type Tree = Record<string, Record<string, { name: string; hoursOld: number }[]>>

function fakeBucket(tree: Tree, over: { listError?: string; removeError?: string } = {}) {
  const removed: string[][] = []
  const page = <T,>(all: T[], o: { limit: number; offset: number }) => all.slice(o.offset, o.offset + o.limit)
  const bucket: UploadSweepBucket = {
    async list(path, o) {
      if (over.listError) return { data: null, error: { message: over.listError } }
      const parts = path.split("/").filter(Boolean)
      if (parts.length === 0) return { data: page(Object.keys(tree).map((name) => ({ name, id: null })), o), error: null }
      if (parts.length === 1) return { data: page(Object.keys(tree[parts[0]] ?? {}).map((name) => ({ name, id: null })), o), error: null }
      const files = tree[parts[0]]?.[parts[1]] ?? []
      return { data: page(files.map((f) => ({ name: f.name, id: `id-${f.name}`, created_at: ago(f.hoursOld) })), o), error: null }
    },
    async remove(paths) {
      if (over.removeError) return { error: { message: over.removeError } }
      removed.push(paths)
      return { error: null }
    },
  }
  return { bucket, removed }
}

const readRowsOf = (rows: SweepRow[]) => vi.fn(async (tokens: string[]) => ({ rows: rows.filter((r) => tokens.includes(r.token)), error: null as string | null }))

describe("sweepBofaUploads", () => {
  const tree: Tree = {
    tokA: { passport: [{ name: "u1-p.pdf", hoursOld: 72 }, { name: "u2-p.pdf", hoursOld: 72 }] },
    tokB: { passport: [{ name: "u3-p.pdf", hoursOld: 72 }] },
    ghost: { passport: [{ name: "u4-p.pdf", hoursOld: 72 }] },
  }
  const rows: SweepRow[] = [
    { token: "tokA", status: "completed", files: [{ path: "tokA/passport/u2-p.pdf" }] },
    { token: "tokB", status: "revoked" },
  ]

  it("walks token/box/file, judges each object and removes exactly the deletable ones", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf(rows) })
    expect(r.error).toBeNull()
    expect(r.listed).toBe(4)
    expect(r.deleted).toBe(2)
    expect(removed.flat().sort()).toEqual(["tokA/passport/u1-p.pdf", "tokB/passport/u3-p.pdf"])
    expect(r.byReason).toMatchObject({ swapped_out_copy: 1, link_closed: 1 })
    expect(r.kept.still_needed).toBe(1)
    expect(r.tokensWithoutRow).toBe(1)
  })

  it("a dry run deletes nothing but reports what it would", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf(rows), dryRun: true })
    expect(removed).toEqual([])
    expect(r.deleted).toBe(0)
    expect(r.wouldDelete).toBe(2)
    expect(r.dryRun).toBe(true)
  })

  it("deletes NOTHING when the applications cannot be read", async () => {
    const { bucket, removed } = fakeBucket(tree)
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: async () => ({ rows: [], error: "Could not read the applications: boom" }) })
    expect(r.error).toContain("boom")
    expect(r.deleted).toBe(0)
    expect(removed).toEqual([])
  })

  it("deletes NOTHING when the bucket cannot be listed", async () => {
    const { bucket, removed } = fakeBucket(tree, { listError: "bucket down" })
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf(rows) })
    expect(r.error).toContain("bucket down")
    expect(removed).toEqual([])
  })

  it("reports a failed removal instead of pretending it worked", async () => {
    const { bucket } = fakeBucket(tree, { removeError: "denied" })
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf(rows) })
    expect(r.error).toContain("denied")
    expect(r.deleted).toBe(0)
  })

  it("does nothing on an empty bucket", async () => {
    const { bucket, removed } = fakeBucket({})
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf([]) })
    expect(r).toMatchObject({ listed: 0, deleted: 0, wouldDelete: 0, error: null })
    expect(removed).toEqual([])
  })

  it("caps one run and removes in chunks of 100", async () => {
    const many: Tree = { tokC: { passport: Array.from({ length: 150 }, (_, i) => ({ name: `u${i}-p.pdf`, hoursOld: 72 })) } }
    const { bucket, removed } = fakeBucket(many)
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf([{ token: "tokC", status: "revoked" }]) })
    expect(r.deleted).toBe(150)
    expect(removed.map((c) => c.length)).toEqual([100, 50])

    const capped = fakeBucket(many)
    const c = await sweepBofaUploads({ now: NOW, bucket: capped.bucket, readRows: readRowsOf([{ token: "tokC", status: "revoked" }]), maxDelete: 30 })
    expect(c.deleted).toBe(30)
    expect(c.wouldDelete).toBe(150)
    expect(c.capped).toBe(true)
  })

  it("stops listing at the listing budget and says so", async () => {
    const many: Tree = { tokC: { passport: Array.from({ length: 150 }, (_, i) => ({ name: `u${i}-p.pdf`, hoursOld: 72 })) } }
    const { bucket } = fakeBucket(many)
    const r = await sweepBofaUploads({ now: NOW, bucket, readRows: readRowsOf([{ token: "tokC", status: "revoked" }]), maxListed: 120, dryRun: true })
    expect(r.capped).toBe(true)
  })
})
