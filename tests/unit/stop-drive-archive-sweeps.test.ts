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
  windows: { withFolder: [] as Array<Record<string, unknown>>, noFolder: [] as Array<Record<string, unknown>>, skippedNoFolder: 0, skippedFinished: 0, readError: null as string | null },
  enqueued: [] as string[],
  alarms: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ table: string; cutoff: string }>,
}))

vi.mock("@/lib/archive/skip-no-drive-folder", async () => {
  const actual = await vi.importActual<typeof import("@/lib/archive/skip-no-drive-folder")>("@/lib/archive/skip-no-drive-folder")
  return {
    ...actual,
    readSweepWindows: vi.fn(async (table: string, _cols: string, cutoff: string) => { state.calls.push({ table, cutoff }); return state.windows }),
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
  state.windows = { withFolder: [], noFolder: [], skippedNoFolder: 0, skippedFinished: 0, readError: null }
  state.enqueued.length = 0
  state.alarms.length = 0
  state.calls.length = 0
})

describe("tax-archive-sweep", () => {
  it("processes only the rows of companies WITH a folder; reports the counts of the rest", async () => {
    state.windows = { withFolder: [{ id: "s2", account_id: "a2" }], noFolder: [], skippedNoFolder: 1200, skippedFinished: 40, readError: null }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(state.enqueued).toEqual(["s2"])
    expect(body).toMatchObject({ candidates: 1, skippedNoFolder: 1200, skippedFinished: 40, unfiledNoFolder: 0 })
    expect(state.calls[0].table).toBe("tax_return_submissions")
  })

  it("a no-folder company's un-filed submissions raise ONE staff-visible alarm per run (not just a counter) — also in dry-run", async () => {
    process.env.TAX_ARCHIVE_SWEEP_DRY_RUN = "true"
    state.windows = { withFolder: [], noFolder: [{ id: "n1", account_id: "x" }, { id: "n2", account_id: "y" }], skippedNoFolder: 2, skippedFinished: 0, readError: null }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(body.unfiledNoFolder).toBe(2)
    expect(state.alarms).toHaveLength(1)
    expect(state.alarms[0]).toMatchObject({ source: "server", route: "/api/cron/tax-archive-sweep" })
    expect(state.alarms[0].context).toMatchObject({ count: 2, ids: ["n1", "n2"] })
    expect(state.enqueued).toEqual([]) // nothing is enqueued for them: they have nowhere to be archived by this job
  })

  it("no no-folder submissions → no alarm", async () => {
    state.windows = { withFolder: [{ id: "s2", account_id: "a2" }], noFolder: [], skippedNoFolder: 0, skippedFinished: 0, readError: null }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    await GET(get())
    expect(state.alarms).toEqual([])
  })

  it("a read error is a 500 with a system error", async () => {
    state.windows = { ...state.windows, readError: "boom" }
    const { GET } = await import("@/app/api/cron/tax-archive-sweep/route")
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect(state.alarms).toHaveLength(1)
  })
})

describe("forms-archive-sweep (banking)", () => {
  it("banking: only companies with a folder are enqueued; counts reported; ONE alarm for the unfiled no-folder submissions", async () => {
    state.windows = { withFolder: [{ id: "b2", account_id: "a2" }], noFolder: [{ id: "b1", account_id: "x" }], skippedNoFolder: 1, skippedFinished: 3, readError: null }
    const { GET } = await import("@/app/api/cron/forms-archive-sweep/route")
    const body = await (await GET(get())).json()
    expect(state.enqueued).toContain("b2")
    expect(state.enqueued).not.toContain("b1")
    expect(body.perForm.banking).toMatchObject({ skippedNoFolder: 1, skippedFinished: 3, unfiledNoFolder: 1 })
    expect(body.skippedNoFolder).toBe(1)
    const noFolderAlarms = state.alarms.filter((a) => String(a.message).includes("banking submissions"))
    expect(noFolderAlarms).toHaveLength(1)
    expect(state.calls[0].table).toBe("banking_submissions")
  })
})
