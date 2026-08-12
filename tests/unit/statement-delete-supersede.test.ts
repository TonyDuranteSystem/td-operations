/**
 * Card 4a39e0fd — delete SUPERSEDES the file's ingest jobs.
 *
 * The live bug (architect blocker B2): the upload path is content-hashed and
 * the enqueue helper skips any path with a non-failed job — so deleting a file
 * and re-uploading the IDENTICAL file found the old completed job, returned
 * "already queued", and the statement silently never came back. Delete must
 * cancel that source's jobs so the re-upload enqueues fresh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = {
  editable: true,
  deletedRows: [{ id: "t1" }, { id: "t2" }],
  cancelUpdates: [] as Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }>,
}

vi.mock("@/lib/tax/resolve-submission", () => ({
  resolveEditability: async () => ({ editable: state.editable }),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "bank_transactions") {
        const b: Record<string, unknown> = {}
        b.delete = () => b
        b.eq = () => b
        b.select = () => Promise.resolve({ data: state.deletedRows, error: null })
        return b
      }
      if (table === "job_queue") {
        const filters: Array<[string, unknown]> = []
        const b: Record<string, unknown> = {}
        b.update = (payload: Record<string, unknown>) => {
          const rec = { payload, filters }
          state.cancelUpdates.push(rec)
          return b
        }
        b.eq = (col: string, v: unknown) => { filters.push([`eq:${col}`, v]); return b }
        b.select = () => Promise.resolve({ data: [{ id: "c1" }], error: null })
        b.like = (col: string, v: unknown) => { filters.push([`like:${col}`, v]); return b }
        b.in = (col: string, v: unknown) => { filters.push([`in:${col}`, v]); return b }
        b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

import { deleteStatementRows, clearFailedStatementFile } from "@/lib/tax/statement-uploads"

const SHA = "a".repeat(64)

beforeEach(() => {
  state.editable = true
  state.deletedRows = [{ id: "t1" }, { id: "t2" }]
  state.cancelUpdates.length = 0
})

describe("deleteStatementRows — job supersede", () => {
  it("cancels the file's ingest jobs (pending/completed/failed) keyed by the sha16 path", async () => {
    const r = await deleteStatementRows("acc-1", 2025, `upload:${SHA}`)
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe(2)
    expect(state.cancelUpdates).toHaveLength(1)
    const upd = state.cancelUpdates[0]
    expect(upd.payload.status).toBe("cancelled")
    const like = upd.filters.find(([k]) => k === "like:payload->>path")
    expect(like?.[1]).toBe(`tax/acc-1/2025/${"a".repeat(16)}\\_%`)
    const statuses = upd.filters.find(([k]) => k === "in:status")
    // 'processing' deliberately NOT cancellable (a running handler can't be stopped).
    expect(statuses?.[1]).toEqual(["pending", "completed", "failed"])
  })

  it("does NOT touch jobs for a Drive-id source (staff legacy rows have no ingest jobs)", async () => {
    const r = await deleteStatementRows("acc-1", 2025, "1DriveFileId")
    expect(r.ok).toBe(true)
    expect(state.cancelUpdates).toHaveLength(0)
  })

  it("still refuses when the submission is locked (semantics unchanged)", async () => {
    state.editable = false
    const r = await deleteStatementRows("acc-1", 2025, `upload:${SHA}`)
    expect(r.ok).toBe(false)
    expect(state.cancelUpdates).toHaveLength(0)
  })
})

describe("clearFailedStatementFile — W9 clear a row-less dead file", () => {
  it("cancels the path's FAILED jobs (owner-scoped by account + year)", async () => {
    const r = await clearFailedStatementFile("acc-1", 2025, "tax/acc-1/2025/x_f.csv")
    expect(r.ok).toBe(true)
    expect(state.cancelUpdates).toHaveLength(1)
    const upd = state.cancelUpdates[0]
    expect(upd.payload.status).toBe("cancelled")
    expect(upd.filters).toEqual(expect.arrayContaining([
      ["eq:payload->>path", "tax/acc-1/2025/x_f.csv"],
      ["eq:status", "failed"],
      ["eq:account_id", "acc-1"],
    ]))
  })

  it("refuses when locked", async () => {
    state.editable = false
    const r = await clearFailedStatementFile("acc-1", 2025, "p")
    expect(r.ok).toBe(false)
    expect(state.cancelUpdates).toHaveLength(0)
  })
})
