/**
 * What the workspace does about the saved copy of an approved tax questionnaire (dev job 7df278cd, Shipment 2): read the view,
 * save now, and choose what happens to the earlier copies. The store, the queue and the database are faked; the RULES are real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const s = vi.hoisted(() => ({
  order: [] as string[],
  rows: {} as Record<string, unknown>,
  jobs: [] as Array<{ status: string; payload: unknown; started_at: string | null }>,
  folders: {} as Record<string, { name: string; parent_id: string | null }>,
  target: null as unknown,
  finished: false,
  archive: null as null | (() => void),
  versions: [] as Array<{ id: string; versionNo: number; createdAt: string; current: boolean }>,
  filed: [] as Array<Record<string, unknown>>,
  fileError: null as string | null,
  merged: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let eqVal: unknown = null
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (_c: string, v: unknown) => { eqVal = v; return chain }
      chain.in = () => chain
      chain.maybeSingle = () => Promise.resolve({ data: table === "store_folders" ? s.folders[eqVal as string] ?? null : (s.rows[table] ?? null), error: null })
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "job_queue" ? s.jobs : [], error: null }).then(resolve)
      return chain
    },
  },
}))
vi.mock("@/lib/tax/target-submission", () => ({ loadTargetTaxSubmission: async () => s.target }))
vi.mock("@/lib/tax/archive-enqueue", () => ({ enqueueTaxArchiveJob: async () => { s.order.push("enqueue"); return { status: "enqueued" } } }))
vi.mock("@/lib/tax/archive-submission", () => ({
  archiveTaxSubmission: async () => { s.order.push("archive"); s.archive?.(); return { status: "archived" } },
}))
vi.mock("@/lib/archive/meta-merge", () => ({
  mergeArchiveMeta: async (_t: string, _id: string, patch: Record<string, unknown>) => {
    s.merged.push(patch)
    const row = s.rows.tax_return_submissions as { drive_archive_meta: Record<string, unknown> | null }
    row.drive_archive_meta = { ...(row.drive_archive_meta ?? {}), ...patch }
  },
}))
vi.mock("@/lib/crm-store/no-storage", () => ({ accountIsFinished: async () => s.finished }))
vi.mock("@/lib/crm-store/document-pointer", () => ({ parseStorePointer: (v: string | null) => (v && v.startsWith("store:") ? v.slice(6) : null) }))
vi.mock("@/lib/crm-store/browse", () => ({
  listFileVersions: async () => s.versions,
  readVersionForStaff: async (_f: string, v: string) => ({ bytes: Buffer.from(`pdf-${v}`), mimeType: "application/pdf", name: `v ${v}` }),
}))
vi.mock("@/lib/crm-store/formation-pilot", () => ({
  savePilotFile: async (p: Record<string, unknown>) => {
    if (s.fileError) throw new Error(s.fileError)
    s.filed.push(p)
    return { status: "created", fileId: `copy-${s.filed.length}` }
  },
}))

const SUB = { id: "ts-1", tax_year: 2025, review_status: "confirmed", review_history: [{ to: "confirmed", at: "2026-11-07T12:00:00Z", by: "Luca" }] }

beforeEach(() => {
  s.order.length = 0
  s.jobs = []
  s.finished = false
  s.archive = null
  s.filed.length = 0
  s.merged.length = 0
  s.fileError = null
  s.target = { ok: true, account_id: "acct-1", sub: { ...SUB } }
  s.folders = { "f-year": { name: "2025", parent_id: "f-tax" }, "f-tax": { name: "3. Tax", parent_id: "f-root" }, "f-root": { name: "Acme LLC", parent_id: null } }
  s.versions = [
    { id: "v2", versionNo: 2, createdAt: "2026-11-07T11:00:00Z", current: true },
    { id: "v1", versionNo: 1, createdAt: "2026-11-04T11:00:00Z", current: false },
  ]
  s.rows = {
    service_deliveries: { id: "sd-1", service_type: "Tax Return", account_id: "acct-1" },
    accounts: { company_name: "Acme LLC" },
    tax_return_submissions: { drive_archived_at: "2026-11-07T11:00:00Z", drive_archive_meta: { filed_in: "storage", summary_file_id: "store:file-1", attempts: 1 } },
    store_files: { id: "file-1", name: "Tax_Data_Acme_LLC.pdf", owner_id: "own-1", folder_id: "f-year", state: "live", trashed_at: null },
  }
})

const archivedRow = () => s.rows.tax_return_submissions as { drive_archived_at: string | null; drive_archive_meta: Record<string, unknown> | null }

describe("loadTaxSaveView", () => {
  it("before approval nothing is promised", async () => {
    s.target = { ok: true, account_id: "acct-1", sub: { ...SUB, review_status: "under_review" } }
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    const r = await loadTaxSaveView("sd-1")
    expect(r.ok && r.view.state.state).toBe("not_released")
  })

  it("approved and saved: where the file is, which version, who approved, and the earlier copy waiting for a choice", async () => {
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    const r = await loadTaxSaveView("sd-1")
    if (r.ok === false) throw new Error(r.error)
    expect(r.view.state.state).toBe("saved")
    expect(r.view.file).toMatchObject({ name: "Tax_Data_Acme_LLC.pdf", path: ["Acme LLC", "3. Tax", "2025"], version: 2, storageHref: "/storage?store=new&owner=own-1&folder=f-year" })
    expect(r.view.approved).toEqual({ at: "2026-11-07T12:00:00Z", by: "Luca" })
    expect(r.view.earlierToDecide.map((v) => v.versionNo)).toEqual([1])
  })

  it("a file that is in the trash is not shown as the saved copy", async () => {
    ;(s.rows.store_files as Record<string, unknown>).trashed_at = "2026-11-07T13:00:00Z"
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    const r = await loadTaxSaveView("sd-1")
    expect(r.ok && r.view.file).toBeNull()
  })

  it("a failed save says why", async () => {
    archivedRow().drive_archived_at = null
    archivedRow().drive_archive_meta = { attempts: 2, last_error: "company c (Acme) has no storage and no folder — there is nowhere to archive its tax package" }
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    const r = await loadTaxSaveView("sd-1")
    expect(r.ok && r.view.state).toMatchObject({ state: "failed", kind: "no_storage", attempts: 2 })
  })

  it("a save running in the background reads as saving; one cut off long ago does not", async () => {
    archivedRow().drive_archived_at = null
    archivedRow().drive_archive_meta = null
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    s.jobs = [{ status: "processing", payload: { submission_id: "ts-1" }, started_at: new Date(Date.now() - 60_000).toISOString() }]
    expect((await loadTaxSaveView("sd-1") as { view: { state: { state: string } } }).view.state.state).toBe("saving")
    s.jobs = [{ status: "processing", payload: { submission_id: "ts-1" }, started_at: new Date(Date.now() - 30 * 60_000).toISOString() }]
    expect((await loadTaxSaveView("sd-1") as { view: { state: { state: string } } }).view.state.state).toBe("not_saved")
    s.jobs = [{ status: "pending", payload: { submission_id: "other" }, started_at: null }]
    expect((await loadTaxSaveView("sd-1") as { view: { state: { state: string } } }).view.state.state).toBe("not_saved")
  })

  it("a job that is not a tax job, or has no questionnaire, is a clear 404", async () => {
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    s.rows.service_deliveries = { id: "sd-1", service_type: "Company Formation", account_id: "acct-1" }
    expect(await loadTaxSaveView("sd-1")).toMatchObject({ ok: false, status: 404 })
    s.rows.service_deliveries = { id: "sd-1", service_type: "Tax Return", account_id: "acct-1" }
    s.target = { ok: false, reason: "no_submission" }
    expect(await loadTaxSaveView("sd-1")).toMatchObject({ ok: false, status: 404 })
  })
})

describe("saveTaxNow", () => {
  beforeEach(() => {
    archivedRow().drive_archived_at = null
    archivedRow().drive_archive_meta = null
  })

  it("refuses before approval", async () => {
    s.target = { ok: true, account_id: "acct-1", sub: { ...SUB, review_status: "under_review" } }
    const { saveTaxNow } = await import("@/lib/tax/tax-save")
    expect(await saveTaxNow("sd-1")).toMatchObject({ ok: false, status: 409 })
    expect(s.order).toEqual([])
  })

  it("queues the durable job FIRST (the fallback), then saves in this request, and returns the fresh view", async () => {
    s.archive = () => { archivedRow().drive_archived_at = "2026-11-07T14:00:00Z"; archivedRow().drive_archive_meta = { filed_in: "storage", summary_file_id: "store:file-1" } }
    const { saveTaxNow } = await import("@/lib/tax/tax-save")
    const r = await saveTaxNow("sd-1")
    expect(s.order).toEqual(["enqueue", "archive"])
    expect(r.ok && r.view.state.state).toBe("saved")
  })

  it("a save that fails is not an error of the request: the view shows the reason", async () => {
    s.archive = () => {
      archivedRow().drive_archive_meta = { attempts: 1, last_error: "save threw: fetch failed" }
      throw new Error("fetch failed")
    }
    const { saveTaxNow } = await import("@/lib/tax/tax-save")
    const r = await saveTaxNow("sd-1")
    expect(r.ok && r.view.state).toMatchObject({ state: "failed", kind: "unreachable" })
  })

  it("a save already running is left to finish; a copy already saved is not saved again", async () => {
    const { saveTaxNow } = await import("@/lib/tax/tax-save")
    s.jobs = [{ status: "processing", payload: { submission_id: "ts-1" }, started_at: new Date().toISOString() }]
    await saveTaxNow("sd-1")
    expect(s.order).toEqual(["enqueue"]) // queued (a no-op for the queue itself), but no second save in parallel
    s.order.length = 0
    s.jobs = []
    archivedRow().drive_archived_at = "2026-11-07T14:00:00Z"
    archivedRow().drive_archive_meta = { filed_in: "storage", summary_file_id: "store:file-1" }
    await saveTaxNow("sd-1")
    expect(s.order).toEqual([])
  })
})

describe("chooseEarlierCopies", () => {
  it("'visible' files each earlier version as its own file next to the approved one, then records the choice", async () => {
    const { chooseEarlierCopies } = await import("@/lib/tax/tax-save")
    const r = await chooseEarlierCopies("sd-1", "visible", "Luca")
    expect(s.filed).toHaveLength(1)
    expect(s.filed[0]).toMatchObject({
      ownerId: "own-1", folderKind: "tax", folderId: "f-year", name: "Tax_Data_Acme_LLC (version 1).pdf", callerKey: "earlier-copy:file-1:v1",
      documentType: "other_document", published: false, periodYear: 2025,
    })
    expect(s.merged[0]).toMatchObject({ earlier_copy: { choice: "visible", covered: 1, by: "Luca" } })
    expect(r.ok && r.view.earlierToDecide).toEqual([]) // the card is gone
  })

  it("'hidden' files nothing and records the choice", async () => {
    const { chooseEarlierCopies } = await import("@/lib/tax/tax-save")
    const r = await chooseEarlierCopies("sd-1", "hidden", "Luca")
    expect(s.filed).toEqual([])
    expect(s.merged[0]).toMatchObject({ earlier_copy: { choice: "hidden", covered: 1 } })
    expect(r.ok && r.view.earlierToDecide).toEqual([])
  })

  it("a copy that could not be filed records NO choice, so the card stays and the button works again", async () => {
    s.fileError = "storage is down"
    const { chooseEarlierCopies } = await import("@/lib/tax/tax-save")
    const r = await chooseEarlierCopies("sd-1", "visible", "Luca")
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect(s.merged).toEqual([])
  })

  it("nothing to decide, or no saved copy yet: a clear refusal and no filing", async () => {
    const { chooseEarlierCopies } = await import("@/lib/tax/tax-save")
    s.versions = [{ id: "v1", versionNo: 1, createdAt: "2026-11-04T11:00:00Z", current: true }]
    expect(await chooseEarlierCopies("sd-1", "visible", "Luca")).toMatchObject({ ok: false, status: 409 })
    s.versions = [{ id: "v2", versionNo: 2, createdAt: "x", current: true }, { id: "v1", versionNo: 1, createdAt: "y", current: false }]
    archivedRow().drive_archived_at = null
    expect(await chooseEarlierCopies("sd-1", "visible", "Luca")).toMatchObject({ ok: false, status: 409 })
    expect(s.filed).toEqual([])
  })

  it("a second choice records ALL earlier copies as covered (not just the new batch), so the card does not come straight back", async () => {
    archivedRow().drive_archive_meta = { filed_in: "storage", summary_file_id: "store:file-1", earlier_copy: { choice: "visible", covered: 1, at: "x", by: "Luca" } }
    s.versions = [
      { id: "v4", versionNo: 4, createdAt: "2026-11-09T11:00:00Z", current: true },
      { id: "v3", versionNo: 3, createdAt: "2026-11-08T11:00:00Z", current: false },
      { id: "v2", versionNo: 2, createdAt: "2026-11-07T11:00:00Z", current: false },
      { id: "v1", versionNo: 1, createdAt: "2026-11-04T11:00:00Z", current: false },
    ]
    const { chooseEarlierCopies } = await import("@/lib/tax/tax-save")
    const r = await chooseEarlierCopies("sd-1", "hidden", "Luca")
    expect(s.merged[0]).toMatchObject({ earlier_copy: { choice: "hidden", covered: 3 } }) // v1, v2, v3 — not just the 2 newly asked about
    expect(r.ok && r.view.earlierToDecide).toEqual([])
  })

  it("a later copy brings the card back after a choice", async () => {
    archivedRow().drive_archive_meta = { filed_in: "storage", summary_file_id: "store:file-1", earlier_copy: { choice: "hidden", covered: 1, at: "x", by: "Luca" } }
    s.versions = [
      { id: "v3", versionNo: 3, createdAt: "2026-11-08T11:00:00Z", current: true },
      { id: "v2", versionNo: 2, createdAt: "2026-11-07T11:00:00Z", current: false },
      { id: "v1", versionNo: 1, createdAt: "2026-11-04T11:00:00Z", current: false },
    ]
    const { loadTaxSaveView } = await import("@/lib/tax/tax-save")
    const r = await loadTaxSaveView("sd-1")
    expect(r.ok && r.view.earlierToDecide.map((v) => v.versionNo)).toEqual([2]) // version 1 was already decided
  })
})
