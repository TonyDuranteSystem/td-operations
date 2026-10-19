/**
 * Stop Drive, slice S1c: the two archive backstop crons.
 *  - The window of 200 is filtered IN THE QUERY (inner join on the company): a company with no folder, or a Closed/Cancelled one,
 *    never occupies it, however many such rows exist — there is no page limit through which starvation could come back.
 *  - A company with no folder is counted, and a submission of such a company that nobody has filed raises ONE alarm (a system
 *    error) every run until it is filed — the skip is never silent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const state = vi.hoisted(() => ({
  window: { candidates: [] as Array<Record<string, unknown>>, skippedFinished: 0, readError: null as string | null },
  enqueued: [] as string[],
  alarms: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ table: string; cutoff: string }>,
}))

vi.mock("@/lib/archive/skip-no-drive-folder", async () => {
  const actual = await vi.importActual<typeof import("@/lib/archive/skip-no-drive-folder")>("@/lib/archive/skip-no-drive-folder")
  return {
    ...actual,
    readSweepWindow: vi.fn(async (table: string, _cols: string, cutoff: string) => { state.calls.push({ table, cutoff }); return state.window }),
  }
})
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; for (const m of ["select", "is", "gte", "order", "limit", "update", "eq"]) c[m] = () => c; c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return c } } }))
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
  state.window = { candidates: [], skippedFinished: 0, readError: null }
  state.enqueued.length = 0
  state.alarms.length = 0
  state.calls.length = 0
})

describe("tax-archive-sweep", () => {
  it("processes the window the query produced — including a company with NO folder (its archive job files it into the storage) — and reports the finished ones it left alone", async () => {
    state.window = { candidates: [{ id: "s1", account_id: "storage-first" }, { id: "s2", account_id: "a2" }], skippedFinished: 40, readError: null }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(state.enqueued).toEqual(["s1", "s2"])
    expect(body).toMatchObject({ candidates: 2, skippedFinished: 40 })
    expect(state.calls[0].table).toBe("tax_return_submissions")
    expect(state.alarms).toEqual([]) // no custom alarm: the existing once-per-row stuck alert is the loud path
  })

  it("asks the query for REAL submissions only (completed / reviewed / has a review status)", async () => {
    const mod = await import("@/lib/archive/skip-no-drive-folder")
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    await GET(get())
    expect(vi.mocked(mod.readSweepWindow).mock.calls.at(-1)?.[3]).toBe("status.in.(completed,reviewed),review_status.not.is.null")
  })

  it("a read error is a 500 with a system error", async () => {
    state.window = { ...state.window, readError: "boom" }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect(state.alarms).toHaveLength(1)
  })
})

describe("forms-archive-sweep (banking)", () => {
  it("banking: the window's rows are enqueued (a no-folder company too: the job files it into the storage); finished companies are counted", async () => {
    state.window = { candidates: [{ id: "b1", account_id: "storage-first" }, { id: "b2", account_id: "a2" }], skippedFinished: 3, readError: null }
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(state.enqueued).toEqual(expect.arrayContaining(["b1", "b2"]))
    expect(body.perForm.banking).toMatchObject({ skippedFinished: 3 })
    expect(body.skippedFinished).toBe(3)
    expect(state.calls[0].table).toBe("banking_submissions")
  })
  it("banking asks only for completed / reviewed submissions", async () => {
    const mod = await import("@/lib/archive/skip-no-drive-folder")
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    await GET(get())
    expect(vi.mocked(mod.readSweepWindow).mock.calls.at(-1)?.[3]).toBe("status.in.(completed,reviewed)")
  })
})
