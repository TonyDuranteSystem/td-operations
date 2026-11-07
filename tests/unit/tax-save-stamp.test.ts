/**
 * ONE time on the saved PDF per client submit (dev job 7df278cd, Shipment 2). Found live: the setup job's inline copy and the durable
 * save job each used their own clock, so one resubmit made two versions (4 and 5) that differed only in the time they print — and the
 * "earlier copies" card would have fired after nearly every approval. Both writers now take the time from here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { answersFingerprint } from "@/lib/tax/answers-fingerprint"

const s = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  merged: [] as Array<Record<string, unknown>>,
  /** what the second read finds (a writer that landed in between) — null = what we wrote */
  racedMeta: null as Record<string, unknown> | null,
  readError: null as string | null,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = () => Promise.resolve(s.readError ? { data: null, error: { message: s.readError } } : { data: s.row, error: null })
      return chain
    },
  },
}))
vi.mock("@/lib/archive/meta-merge", () => ({
  mergeArchiveMeta: async (_t: string, _id: string, patch: Record<string, unknown>) => {
    s.merged.push(patch)
    if (s.row) s.row = { ...s.row, drive_archive_meta: s.racedMeta ?? { ...((s.row.drive_archive_meta as Record<string, unknown>) ?? {}), ...patch } }
  },
}))

const ANSWERS = { a: "No" }
const PATHS = ["p/1.pdf"]
const FP = answersFingerprint(ANSWERS, PATHS)

beforeEach(() => {
  s.merged.length = 0
  s.racedMeta = null
  s.readError = null
  s.row = { submitted_data: { ...ANSWERS }, upload_paths: [...PATHS], drive_archive_meta: {} }
})

describe("pickStamp (pure)", () => {
  it("reuses the time pinned for the SAME answers", async () => {
    const { pickStamp } = await import("@/lib/tax/save-stamp")
    expect(pickStamp({ stamp: { fp: "f1", at: "2026-11-01T10:00:00.000Z" } }, "f1", "2026-11-09T00:00:00.000Z")).toEqual({ stamp: { fp: "f1", at: "2026-11-01T10:00:00.000Z" }, isNew: false })
  })
  it("pins a fresh time for CHANGED answers, or when nothing is pinned or the record is damaged", async () => {
    const { pickStamp } = await import("@/lib/tax/save-stamp")
    for (const meta of [{ stamp: { fp: "other", at: "x" } }, {}, null, "garbage", { stamp: "bad" }]) {
      expect(pickStamp(meta, "f1", "NOW")).toEqual({ stamp: { fp: "f1", at: "NOW" }, isNew: true })
    }
  })
})

describe("pinnedSubmitStamp", () => {
  it("the first writer pins a time, stores it, and uses it", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    const st = await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-07T10:00:00.000Z"))
    expect(st).toEqual({ fp: FP, at: "2026-11-07T10:00:00.000Z" })
    expect(s.merged).toEqual([{ stamp: st }])
  })

  it("the SECOND writer (the other path, a minute later) takes the same time and writes nothing", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    const first = await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-07T10:00:00.000Z"))
    s.merged.length = 0
    const second = await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-07T10:01:30.000Z"))
    expect(second).toEqual(first)
    expect(s.merged).toEqual([])
  })

  it("changed answers pin a new time", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-07T10:00:00.000Z"))
    s.row = { ...s.row!, submitted_data: { a: "Yes" } }
    const st = await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-08T09:00:00.000Z"))
    expect(st.at).toBe("2026-11-08T09:00:00.000Z")
    expect(st.fp).toBe(answersFingerprint({ a: "Yes" }, PATHS))
  })

  it("two writers pinning at the same instant: the stored time wins, both use it", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    s.racedMeta = { stamp: { fp: FP, at: "2026-11-07T10:00:00.500Z" } } // the other writer's write landed last
    const st = await pinnedSubmitStamp("ts-1", undefined, new Date("2026-11-07T10:00:00.000Z"))
    expect(st.at).toBe("2026-11-07T10:00:00.500Z")
  })

  it("a caller that already has the row does not read it again, and an upload list of mixed entries is handled", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    s.readError = "must not be read"
    const st = await pinnedSubmitStamp("ts-1", { submitted_data: ANSWERS, upload_paths: [...PATHS, null, 3], drive_archive_meta: { stamp: { fp: FP, at: "T" } } })
    expect(st).toEqual({ fp: FP, at: "T" })
  })

  it("a database error is thrown (the setup job then keeps its own clock; the save job retries)", async () => {
    const { pinnedSubmitStamp } = await import("@/lib/tax/save-stamp")
    s.readError = "db down"
    await expect(pinnedSubmitStamp("ts-1")).rejects.toThrow(/db down/)
    s.readError = null
    s.row = null
    await expect(pinnedSubmitStamp("ts-1")).rejects.toThrow(/not found/)
  })
})

describe("both writers use it", () => {
  it("the setup job's inline copy takes the pinned time, falling back to its own clock only if that fails", () => {
    const src = readFileSync("lib/jobs/handlers/tax-form-setup.ts", "utf8")
    expect(src).toContain('pinnedSubmitStamp(p.submission_id)')
    expect(src).toContain("submittedAt: stampAt,")
    expect(src).toMatch(/let stampAt = now/)
  })
  it("the durable save job takes it from the same place", () => {
    const src = readFileSync("lib/tax/archive-submission.ts", "utf8")
    expect(src).toContain("await pinnedSubmitStamp(submissionId, s)")
    expect(src).toContain("submittedAt: stamp.at,")
  })
  it("the inline copy tags the summary file with the tax year, like the durable job", () => {
    const src = readFileSync("lib/form-to-drive.ts", "utf8")
    expect(src).toMatch(/callerKey: `form-summary:\$\{switched\.id\}:\$\{formType\}:\$\{meta\.token\}`, periodYear:/)
  })
})
