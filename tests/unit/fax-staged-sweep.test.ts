import { describe, it, expect } from "vitest"
import { staleStagedPaths, sweepFaxStaging, type StagingBucket, type StagedObject } from "@/lib/fax/staged-sweep"

const U1 = "123e4567-e89b-12d3-a456-426614174000", U2 = "223e4567-e89b-12d3-a456-426614174000"
const now = new Date("2026-10-20T12:00:00Z")

describe("staleStagedPaths — expiry of staged fax uploads", () => {
  it("deletes what is older than 24 hours, keeps what is newer", () => {
    const out = staleStagedPaths([
      { name: `${U1}.pdf`, created_at: "2026-10-19T11:00:00Z" },
      { name: `${U2}.pdf`, created_at: "2026-10-20T11:00:00Z" },
    ], now)
    expect(out).toEqual([`fax-upload/${U1}.pdf`])
  })
  it("an object with NO readable time is left alone (it may be being written right now); one of another shape is never touched", () => {
    expect(staleStagedPaths([{ name: `${U1}.pdf` }, { name: `${U2}.pdf`, created_at: null }], now)).toEqual([])
    expect(staleStagedPaths([{ name: "notes.txt", created_at: "2020-01-01T00:00:00Z" }, { name: "../x.pdf", created_at: "2020-01-01T00:00:00Z" }], now)).toEqual([])
  })
})

describe("sweepFaxStaging — against a fake bucket", () => {
  function fake(objs: StagedObject[], over: { listError?: boolean; removeError?: boolean } = {}) {
    const removed: string[][] = []
    const bucket: StagingBucket = {
      list: async () => over.listError ? { data: null, error: { message: "list failed" } } : { data: objs, error: null },
      remove: async (p) => { removed.push(p); return over.removeError ? { error: { message: "rm failed" } } : { error: null } },
    }
    return { bucket, removed }
  }
  it("deletes only the old, valid staged files", async () => {
    const f = fake([{ name: `${U1}.pdf`, created_at: "2026-10-18T00:00:00Z" }, { name: `${U2}.pdf`, created_at: "2026-10-20T11:30:00Z" }, { name: "readme.txt", created_at: "2020-01-01T00:00:00Z" }, { name: `${U1.replace("1", "9")}.pdf`, created_at: null }])
    const r = await sweepFaxStaging(now, f.bucket)
    expect(r).toEqual({ checked: 4, deleted: 1, error: null }); expect(f.removed).toEqual([[`fax-upload/${U1}.pdf`]])
  })
  it("nothing old = nothing removed (no call); errors are reported, never thrown", async () => {
    const f = fake([{ name: `${U2}.pdf`, created_at: "2026-10-20T11:30:00Z" }])
    expect((await sweepFaxStaging(now, f.bucket)).deleted).toBe(0); expect(f.removed).toEqual([])
    expect(await sweepFaxStaging(now, fake([], { listError: true }).bucket)).toMatchObject({ error: "list failed", deleted: 0 })
    expect(await sweepFaxStaging(now, fake([{ name: `${U1}.pdf`, created_at: "2026-10-01T00:00:00Z" }], { removeError: true }).bucket)).toMatchObject({ error: "rm failed", deleted: 0 })
  })
})
