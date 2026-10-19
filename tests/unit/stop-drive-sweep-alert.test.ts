/**
 * Stop Drive, slice S1c round 5: the sweeps' REAL decision (nothing about the decision is stubbed here).
 *  - A real submission with NO company is no longer skipped quietly: it is enqueued (the archive job fails on it) and, once its
 *    attempts are used up, ALERTED once — the alert flag is merged into the row (never a copy of a stale one).
 *  - A row whose one alert already fired, and an unfilled shell, are left alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const state = vi.hoisted(() => ({
  window: [] as Array<Record<string, unknown>>,
  windowTable: "tax_return_submissions",
  enqueued: [] as string[],
  merged: [] as Array<{ table: string; id: string; patch: Record<string, unknown> }>,
  posted: [] as string[],
  errors: [] as string[],
}))

vi.mock("@/lib/archive/skip-no-drive-folder", () => ({
  readSweepWindow: async (table: string) => ({ candidates: table === state.windowTable ? state.window : [], skippedFinished: 0, readError: null }),
}))
vi.mock("@/lib/archive/meta-merge", () => ({ mergeArchiveMeta: async (table: string, id: string, patch: Record<string, unknown>) => { state.merged.push({ table, id, patch }) } }))
vi.mock("@/lib/cron-log", () => ({ logCron: () => undefined }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (e: { message: string }) => { state.errors.push(e.message); return null } }))
vi.mock("@/lib/team/post-message", () => ({ postTeamMessage: async (m: { message: string }) => { state.posted.push(m.message) } }))
vi.mock("@/lib/tax/archive-enqueue", () => ({ enqueueTaxArchiveJob: async (p: { submissionId: string }) => { state.enqueued.push(p.submissionId); return { status: "enqueued" } } }))
vi.mock("@/lib/forms/archive-enqueue", () => ({ enqueueFormArchiveJob: async (p: { submissionId: string }) => { state.enqueued.push(p.submissionId); return { status: "enqueued" } } }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))

const get = () => new NextRequest("http://localhost/x", { method: "GET" })
const OLD = "2026-09-01T00:00:00Z" // after the cutoff, long past the grace window
const taxRow = (o: Record<string, unknown>) => ({ id: "t", account_id: null, status: "completed", review_status: null, created_at: OLD, drive_archived_at: null, drive_archive_meta: null, ...o })

beforeEach(() => {
  delete process.env.CRON_SECRET
  process.env.TAX_ARCHIVE_SWEEP_DRY_RUN = "false"
  process.env.FORMS_ARCHIVE_SWEEP_DRY_RUN = "false"
  state.window = []
  state.windowTable = "tax_return_submissions"
  for (const k of ["enqueued", "merged", "posted", "errors"] as const) state[k].length = 0
})

describe("tax-archive-sweep — the real decision", () => {
  it("a real tax row with NO company is enqueued (loud via the job), never skipped quietly", async () => {
    state.window = [taxRow({ id: "no-co" })]
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    await GET(get())
    expect(state.enqueued).toEqual(["no-co"])
  })

  it("a row whose attempts are used up is alerted ONCE: the flag is merged, the team and the error log hear it", async () => {
    state.window = [taxRow({ id: "stuck", account_id: "a1", drive_archive_meta: { attempts: 5, last_error: "boom" } })]
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.stuck).toEqual(["stuck"])
    expect(state.merged).toEqual([{ table: "tax_return_submissions", id: "stuck", patch: { sweep_alerted: true } }])
    expect(state.posted).toHaveLength(1)
    expect(state.posted[0]).toContain("could NOT be filed in the client's storage")
    expect(state.posted[0]).not.toContain("Drive")
    expect(state.errors.some((m) => m.includes("stuck"))).toBe(true)
  })

  it("an already-alerted row and an unfilled shell are left alone", async () => {
    state.window = [
      taxRow({ id: "done-alert", account_id: "a1", drive_archive_meta: { attempts: 5, sweep_alerted: true } }),
      taxRow({ id: "shell", account_id: "a1", status: "pending", review_status: null }),
    ]
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.stuck).toEqual([])
    expect(state.enqueued).toEqual([])
    expect(state.merged).toEqual([])
    expect(state.posted).toEqual([])
  })
})

describe("forms-archive-sweep — the real decision", () => {
  // the banking sweep starts 19 Oct 2026: the clock is set after it and the rows are younger than it is old
  beforeEach(() => { state.windowTable = "banking_submissions"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T12:00:00Z")) })
  afterEach(() => { vi.useRealTimers() })
  const bankRow = (o: Record<string, unknown>) => ({ id: "b", account_id: null, status: "completed", created_at: "2026-10-25T00:00:00Z", drive_archived_at: null, drive_archive_meta: null, ...o })

  it("a completed banking row with no company is enqueued; one with used-up attempts is alerted once, flag merged into ITS table", async () => {
    state.window = [bankRow({ id: "b-new" }), bankRow({ id: "b-stuck", drive_archive_meta: { attempts: 5 } })]
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(state.enqueued).toEqual(["b-new"])
    expect(body.stuck).toEqual(["banking:b-stuck"])
    expect(state.merged).toEqual([{ table: "banking_submissions", id: "b-stuck", patch: { sweep_alerted: true } }])
    expect(state.posted[0]).toContain("could NOT be filed in the client's storage")
  })

  it("an unfilled banking shell is left alone", async () => {
    state.window = [bankRow({ id: "shell", status: "pending" })]
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    await GET(get())
    expect(state.enqueued).toEqual([])
  })
})
