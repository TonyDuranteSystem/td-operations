/**
 * The save job is queued once per client submit (dev job 7df278cd, Shipment 2): only a job that is WAITING or RUNNING blocks a new
 * one. A finished job (from the first submit) must not stop the save of a resubmit; a failed job never blocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const q = vi.hoisted(() => ({
  sub: { id: "ts-1", account_id: "acct-1", drive_archived_at: null } as Record<string, unknown> | null,
  jobs: [] as Array<{ id: string; payload: unknown }>,
  inCalls: [] as unknown[][],
  inserted: [] as unknown[],
  /** a database error to return for the submission read / the waiting-jobs read / the insert */
  subError: null as string | null,
  jobsError: null as string | null,
  insertError: null as string | null,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.neq = () => chain
      chain.in = (...a: unknown[]) => { q.inCalls.push(a); return chain }
      chain.maybeSingle = () => Promise.resolve(q.subError && table === "tax_return_submissions" ? { data: null, error: { message: q.subError } } : { data: table === "tax_return_submissions" ? q.sub : null, error: null })
      chain.insert = (row: unknown) => { q.inserted.push(row); return Promise.resolve({ error: q.insertError ? { message: q.insertError } : null }) }
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(q.jobsError ? { data: null, error: { message: q.jobsError } } : { data: q.jobs, error: null }).then(resolve)
      return chain
    },
  },
}))

beforeEach(() => {
  q.sub = { id: "ts-1", account_id: "acct-1", drive_archived_at: null }
  q.jobs = []
  q.inCalls.length = 0
  q.inserted.length = 0
  q.subError = null
  q.jobsError = null
  q.insertError = null
})

describe("enqueueTaxArchiveJob", () => {
  it("looks only at jobs that are waiting or running", async () => {
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    await enqueueTaxArchiveJob({ submissionId: "ts-1" })
    expect(q.inCalls).toContainEqual(["status", ["pending", "processing"]])
  })

  it("queues the save when no job is waiting or running (the first submit's finished job does not block)", async () => {
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    expect((await enqueueTaxArchiveJob({ submissionId: "ts-1", createdBy: "portal_wizard" })).status).toBe("enqueued")
    expect(q.inserted).toHaveLength(1)
    expect(q.inserted[0]).toMatchObject({ job_type: "archive_tax_submission", payload: { submission_id: "ts-1", account_id: "acct-1" }, created_by: "portal_wizard" })
  })

  it("a waiting or running job for THIS submission blocks a second one", async () => {
    q.jobs = [{ id: "j1", payload: { submission_id: "ts-1" } }]
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    expect((await enqueueTaxArchiveJob({ submissionId: "ts-1" })).status).toBe("already_queued")
    expect(q.inserted).toHaveLength(0)
  })

  it("a job for ANOTHER submission does not block", async () => {
    q.jobs = [{ id: "j2", payload: { submission_id: "ts-9" } }]
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    expect((await enqueueTaxArchiveJob({ submissionId: "ts-1" })).status).toBe("enqueued")
  })

  it("an already saved submission queues nothing; a missing one says so", async () => {
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    q.sub = { id: "ts-1", account_id: "acct-1", drive_archived_at: "2026-11-07T10:00:00Z" }
    expect((await enqueueTaxArchiveJob({ submissionId: "ts-1" })).status).toBe("already_archived")
    q.sub = null
    expect((await enqueueTaxArchiveJob({ submissionId: "ts-1" })).status).toBe("no_submission")
    expect(q.inserted).toHaveLength(0)
  })
  // A failed read is not "no such submission", and a failed insert is not "queued": the callers catch a throw, and used to be told "enqueued" for a save that was never queued.
  it("a failed insert THROWS instead of reporting a queued save", async () => {
    q.insertError = "connection reset"
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    await expect(enqueueTaxArchiveJob({ submissionId: "ts-1" })).rejects.toThrow(/could not queue the save job: connection reset/)
  })

  it("a failed read of the submission THROWS (it is not 'no submission')", async () => {
    q.subError = "timeout"
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    await expect(enqueueTaxArchiveJob({ submissionId: "ts-1" })).rejects.toThrow(/submission read failed: timeout/)
    expect(q.inserted).toHaveLength(0)
  })

  it("a failed read of the waiting jobs THROWS and queues nothing (it could be hiding a job that is already waiting)", async () => {
    q.jobsError = "timeout"
    const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
    await expect(enqueueTaxArchiveJob({ submissionId: "ts-1" })).rejects.toThrow(/job list read failed: timeout/)
    expect(q.inserted).toHaveLength(0)
  })
})
