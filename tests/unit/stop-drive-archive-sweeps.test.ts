/**
 * Stop Drive, slice S1c (dev job 264bb882): the two archive backstop crons skip a company that has no folder instead of
 * queueing a job that can only throw, and COUNT the skip in their result. A failed lookup skips nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  enqueued: [] as string[],
  accountsError: false,
  paged: null as null | Array<Record<string, unknown>>,
  alarms: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  const base = h.makeSupabase(state.rows, state.recorded as never)
  const from = (table: string) => {
    const chain = base.from(table) as Record<string, unknown>
    if (state.paged && (table === "tax_return_submissions" || table === "banking_submissions")) {
      const c: Record<string, unknown> = {}
      for (const m of ["select", "is", "gte", "order"]) c[m] = () => c
      c.range = (from: number, to: number) => Promise.resolve({ data: (state.paged as Array<Record<string, unknown>>).slice(from, to + 1), error: null })
      return c
    }
    if (table === "accounts" && state.accountsError) chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "read failed" } }).then(r)
    return chain
  }
  return { supabaseAdmin: { from, storage: base.storage } }
})
vi.mock("@/lib/cron-log", () => ({ logCron: () => undefined }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (e: Record<string, unknown>) => { state.alarms.push(e); return null } }))
vi.mock("@/lib/team/post-message", () => ({ postTeamMessage: async () => undefined }))
vi.mock("@/lib/tax/archive-sweep", () => ({ decideArchiveSweep: () => "enqueue", ARCHIVE_SWEEP_CUTOFF_ISO: "2026-01-01", ARCHIVE_SWEEP_MAX_PER_RUN: 50, ARCHIVE_SWEEP_ALERTED_KEY: "k", ARCHIVE_SWEEP_CHANNEL: "c" }))
vi.mock("@/lib/forms/archive-sweep", () => ({ decideFormArchiveSweep: () => "enqueue", FORM_ARCHIVE_SWEEP_CUTOFF_ISO: "2026-01-01", FORM_ARCHIVE_SWEEP_MAX_PER_RUN: 50, FORM_ARCHIVE_SWEEP_ALERTED_KEY: "k", FORM_ARCHIVE_SWEEP_CHANNEL: "c" }))
vi.mock("@/lib/tax/archive-enqueue", () => ({ enqueueTaxArchiveJob: async (p: { submissionId: string }) => { state.enqueued.push(p.submissionId); return { status: "enqueued" } } }))
vi.mock("@/lib/forms/archive-enqueue", () => ({ enqueueFormArchiveJob: async (p: { submissionId: string }) => { state.enqueued.push(p.submissionId); return { status: "enqueued" } } }))

const get = () => new NextRequest("http://localhost/x", { method: "GET" })

beforeEach(() => {
  delete process.env.CRON_SECRET
  process.env.TAX_ARCHIVE_SWEEP_DRY_RUN = "false"
  process.env.FORMS_ARCHIVE_SWEEP_DRY_RUN = "false"
  state.enqueued.length = 0
  state.alarms.length = 0
  state.recorded.length = 0
  state.accountsError = false
  state.paged = null
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.accounts = [{ id: "acct-no-folder", drive_folder_id: null }, { id: "acct-folder", drive_folder_id: "F1" }]
})

describe("tax-archive-sweep", () => {
  beforeEach(() => {
    state.rows.tax_return_submissions = [
      { id: "s1", account_id: "acct-no-folder" },
      { id: "s2", account_id: "acct-folder" },
      { id: "s3", account_id: null },
    ]
  })

  it("skips the company with no folder, counts it, enqueues the rest", async () => {
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.skippedNoFolder).toBe(1)
    expect(state.enqueued.sort()).toEqual(["s2", "s3"])
    expect(body.enqueuedIds.sort()).toEqual(["s2", "s3"])
  })

  it("a failed folder lookup skips nothing and raises a system error", async () => {
    state.accountsError = true
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.skippedNoFolder).toBe(0)
    expect(state.enqueued.sort()).toEqual(["s1", "s2", "s3"])
    expect(state.alarms).toHaveLength(1)
  })
})

describe("tax-archive-sweep — skipped rows never use up the window of 200", () => {
  it("201 storage-only rows (no folder) followed by 1 real row: the real row is found and enqueued (was: candidates 0)", async () => {
    state.paged = [...Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, account_id: "acct-no-folder" })), { id: "real-1", account_id: "acct-folder" }]
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.skippedNoFolder).toBe(201)
    expect(body.candidates).toBe(1)
    expect(state.enqueued).toEqual(["real-1"])
  })
  it("a Drive-state company WITH a folder is still enqueued as before", async () => {
    state.paged = [{ id: "d1", account_id: "acct-folder" }]
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.skippedNoFolder).toBe(0)
    expect(state.enqueued).toEqual(["d1"])
  })
})

describe("forms-archive-sweep — skipped rows never use up the window of 200", () => {
  it("201 storage-only banking rows followed by 1 real row: the real row is enqueued", async () => {
    state.paged = [...Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, account_id: "acct-no-folder" })), { id: "real-1", account_id: "acct-folder" }]
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.perForm.banking.skippedNoFolder).toBe(201)
    expect(state.enqueued).toContain("real-1")
  })
})

describe("forms-archive-sweep", () => {
  it("banking: skips the company with no folder and counts it; other forms are untouched", async () => {
    const { ARCHIVE_RECIPES } = await import("@/lib/forms/archive-registry")
    const banking = ARCHIVE_RECIPES.banking
    const itin = ARCHIVE_RECIPES.itin
    state.rows[banking.table] = [
      { id: "b1", account_id: "acct-no-folder" },
      { id: "b2", account_id: "acct-folder" },
    ]
    if (itin && itin.table !== banking.table) state.rows[itin.table] = [{ id: "i1", account_id: "acct-no-folder" }]
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.skippedNoFolder).toBe(1)
    expect(body.perForm.banking.skippedNoFolder).toBe(1)
    expect(state.enqueued).toContain("b2")
    expect(state.enqueued).not.toContain("b1")
    if (itin && itin.table !== banking.table) expect(state.enqueued).toContain("i1")
  })
})
