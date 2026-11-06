import { describe, it, expect, vi, beforeEach } from "vitest"

// Company Closure Part B — the wizard route: files where the wizard's company decides, moves the job on by itself, sends NO email to support.
const h = vi.hoisted(() => ({
  single: {} as Record<string, unknown>,
  list: {} as Record<string, unknown>,
  errors: {} as Record<string, string>,
  advance: vi.fn(),
  createSD: vi.fn(),
  resolveDest: vi.fn(),
  registerDocs: vi.fn(),
  filePackage: vi.fn(),
  enqueue: vi.fn(),
  gmailPost: vi.fn(),
  reportError: vi.fn(),
  inserts: [] as Array<{ table: string; row: unknown }>,
  updates: [] as Array<{ table: string; row: unknown }>,
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string): unknown => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "is", "or", "not", "limit", "order", "in", "delete"]) b[m] = () => b
    b.insert = (row: unknown) => { h.inserts.push({ table, row }); return b }
    b.update = (row: unknown) => { h.updates.push({ table, row }); return b }
    b.single = async () => ({ data: h.single[table] ?? null, error: null })
    b.maybeSingle = async () => ({ data: h.single[table] ?? null, error: null })
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(h.errors[table] ? { data: null, error: { message: h.errors[table] } } : { data: h.list[table] ?? [], error: null }).then(res)
    return b
  }
  return { supabaseAdmin: { from: builder } }
})
vi.mock("@/lib/db", () => ({ dbWriteSafe: async (p: unknown) => p }))
vi.mock("@/lib/operations/service-delivery", () => ({ createSD: h.createSD, advanceStageIfAt: h.advance }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: h.reportError }))
vi.mock("@/lib/forms/closure-destination", async (importActual) => ({ ...(await importActual<typeof import("@/lib/forms/closure-destination")>()), resolveClosureDestination: h.resolveDest }))
vi.mock("@/lib/forms/closure-documents", () => ({ registerClosurePackageDocuments: h.registerDocs }))
vi.mock("@/lib/forms/file-form-package", () => ({ fileFormPackage: h.filePackage }))
vi.mock("@/lib/forms/archive-enqueue", () => ({ enqueueFormArchiveJob: h.enqueue }))
vi.mock("@/lib/forms/archive-registry", () => ({ deriveUploadPaths: () => [] }))
vi.mock("@/lib/portal/wizard-uploads", () => ({ isWizardUploadPath: () => false }))
vi.mock("@/lib/portal/chat-events", () => ({
  emitClosureWizardSubmittedEvent: async () => ({ emitted: true, message_id: "m-1" }),
  retireClosureWizardSubmittedNote: async () => ({ retired: 0 }),
}))
vi.mock("@/lib/gmail", () => ({ gmailPost: h.gmailPost }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: vi.fn(async () => {}) }))

import { POST } from "@/app/api/closure-form-completed/route"

type Step = { step: string; status: string; detail?: string }
const call = async (body: Record<string, unknown>): Promise<{ ok: boolean; results: Step[] }> => {
  const res = await POST(new Request("http://x/api/closure-form-completed", { method: "POST", body: JSON.stringify(body) }) as never)
  return (await res.json()) as { ok: boolean; results: Step[] }
}
const stepOf = (r: Step[], name: string) => r.find((s) => s.step === name)

const otherCompany = { folderId: "person-storage:contact-1", storeRootSubFolder: "Company closure_Italyflow LLC", kind: "other_company", disagreement: null, storageOwnerId: "owner-person" }
const staffNote = () => h.inserts.find((i) => i.table === "service_delivery_notes")?.row as { service_delivery_id: string; body: string; author_name: string } | undefined
const clientNote = () => (h.updates.find((u) => u.table === "service_deliveries")?.row as { notes?: string } | undefined)?.notes

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts.length = 0; h.updates.length = 0; h.errors = {}
  h.single = {
    closure_submissions: {
      id: "sub-1", token: "tok-1", status: "completed", completed_at: "2026-11-06T10:00:00Z", last_processed_hash: null,
      submitted_data: { owner_name: "Christian Ranieri", llc_name: "Italyflow LLC", llc_ein: "55-1234567", llc_state: "NM" },
      upload_paths: [], contact_id: "contact-1", account_id: null, lead_id: null, drive_archive_meta: null,
    },
    service_deliveries: { id: "sd-1", status: "active", account_id: null, notes: "" },
  }
  h.list = { service_deliveries: [] }
  h.resolveDest.mockResolvedValue(otherCompany)
  h.filePackage.mockResolvedValue({ step: "storage_save", status: "ok", detail: "filed" })
  h.advance.mockResolvedValue({ advanced: true, current_stage: "Data Collection", reason: "ok" })
  h.createSD.mockResolvedValue({ id: "sd-new" })
  h.registerDocs.mockResolvedValue({ registered: 3, inserted: 3 })
  h.reportError.mockResolvedValue(undefined)
})

describe("closure-form-completed — Part B", () => {
  it("moves the named job from Data Collection to State Compliance Check — no auto-tasks and NO notice to the client", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.advance).toHaveBeenCalledTimes(1)
    expect(h.advance).toHaveBeenCalledWith(expect.objectContaining({
      delivery_id: "sd-1", if_current_stage: "Data Collection", target_stage: "State Compliance Check", skip_tasks: true, skip_notify: true,
    }))
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "ok" })
  })

  it("sends NO email to support — the old step is reported as skipped and Gmail is never called", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.gmailPost).not.toHaveBeenCalled()
    expect(stepOf(r.results, "luca_email")).toMatchObject({ status: "skipped" })
  })

  it("files in the person's 'Company closure_<name>' folder and pins the SAME folder for the retry job", async () => {
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.filePackage).toHaveBeenCalledWith(expect.objectContaining({ driveFolderId: "person-storage:contact-1", storeRootSubFolder: "Company closure_Italyflow LLC" }))
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      pin: expect.objectContaining({ folderId: "person-storage:contact-1", storeRootSubFolder: "Company closure_Italyflow LLC" }),
    }))
  })

  it("a company of ours: filed in that company's storage, no person sub-folder, nothing pinned for one", async () => {
    h.resolveDest.mockResolvedValue({ folderId: "account-storage:acc-a", kind: "company", disagreement: null })
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    const filed = h.filePackage.mock.calls[0][0]
    expect(filed.driveFolderId).toBe("account-storage:acc-a")
    expect(filed.storeRootSubFolder).toBeUndefined()
    expect(h.enqueue.mock.calls[0][0].pin).not.toHaveProperty("storeRootSubFolder")
  })

  it("the destination is decided with the named job's own company link when the submission has none", async () => {
    h.single.service_deliveries = { id: "sd-1", status: "active", account_id: "acc-a", notes: "" }
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.resolveDest).toHaveBeenCalledWith(expect.objectContaining({ linkedAccountId: "acc-a", contactId: "contact-1" }))
  })

  it("the submission's own company link wins when it has one", async () => {
    ;(h.single.closure_submissions as Record<string, unknown>).account_id = "acc-sub"
    h.single.service_deliveries = { id: "sd-1", status: "active", account_id: "acc-job", notes: "" }
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.resolveDest).toHaveBeenCalledWith(expect.objectContaining({ linkedAccountId: "acc-sub" }))
  })

  it("a disagreement tells staff what to check (error log + a step + the STAFF-ONLY team note) — and never reaches the client-visible job note (bug hunt 2026-11-06)", async () => {
    const line = "The client wrote Italyflow LLC, but this closure is linked to Datavora LLC — check which company is being closed."
    h.resolveDest.mockResolvedValue({ ...otherCompany, disagreement: line })
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(line) }))
    expect(stepOf(r.results, "destination_check")).toMatchObject({ status: "skipped", detail: line })
    expect(staffNote()).toMatchObject({ service_delivery_id: "sd-1", author_name: "Closure wizard" })
    expect(staffNote()!.body).toContain("CHECK:")
    expect(staffNote()!.body).toContain("Company closure_Italyflow LLC")
    // the job's own `notes` are shown to the client on the portal service page: neutral, no folder, no "check this"
    expect(clientNote()).toBeDefined()
    expect(clientNote()).not.toContain("CHECK")
    expect(clientNote()).not.toContain("Company closure_")
    expect(clientNote()).toContain("Closure form completed. Data filed.")
  })
  it("no disagreement → no staff alert about the destination", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "destination_check")).toBeUndefined()
    expect(h.reportError).not.toHaveBeenCalled()
  })

  it("a job that already moved on (a resubmission, a retry, staff) is left alone — reported as skipped, not an error", async () => {
    h.advance.mockResolvedValue({ advanced: false, current_stage: "IRS Closure", reason: 'Current stage "IRS Closure" not in gate [Data Collection]' })
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "skipped" })
  })

  it("a move that fails while the job is still on Data Collection is an ERROR step (the setup job retries it)", async () => {
    h.advance.mockResolvedValue({ advanced: false, current_stage: "Data Collection", reason: "boom", result: { error: "the move failed" } })
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "error", detail: "the move failed" })
  })

  it("a throw from the move is an error step, and the rest of the chain still runs", async () => {
    h.advance.mockRejectedValue(new Error("network"))
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "error", detail: "network" })
    expect(stepOf(r.results, "whats_new")).toBeDefined()
  })

  it("a brand-new job created by this very submission is NOT moved on — it stays on Data Collection for staff to check (QA 2026-11-06)", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1" }) // legacy link: no named job, none found → created
    expect(h.createSD).toHaveBeenCalledTimes(1)
    expect(h.advance).not.toHaveBeenCalled()
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "skipped", detail: expect.stringContaining("created by the wizard itself") })
  })

  it("a retry of the pass that created the job (found by this wizard's own token) does not move it either", async () => {
    h.list.service_deliveries = [{ id: "sd-made-here", source_closure_token: "tok-1" }]
    const r = await call({ submission_id: "sub-1", token: "tok-1" })
    expect(h.createSD).not.toHaveBeenCalled()
    expect(h.advance).not.toHaveBeenCalled()
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "skipped" })
  })

  it("a cancelled or finished job is still refused (409) and nothing moves", async () => {
    h.single.service_deliveries = { id: "sd-1", status: "cancelled", account_id: null, notes: "" }
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" }) }) as never)
    expect(res.status).toBe(409)
    expect(h.advance).not.toHaveBeenCalled()
  })

  it("the What's New note is still posted (it is now the only notification)", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "whats_new")).toMatchObject({ status: "ok" })
  })

  it("a correction keeps the folder the first pass pinned — the file, the pin and the staff note all name the folder that exists", async () => {
    ;(h.single.closure_submissions as Record<string, unknown>).drive_archive_meta = { pinned_plan: { storeRootSubFolder: "Company closure_Old Typo LLC" } }
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.filePackage).toHaveBeenCalledWith(expect.objectContaining({ storeRootSubFolder: "Company closure_Old Typo LLC" }))
    expect(h.enqueue.mock.calls[0][0].pin).toMatchObject({ storeRootSubFolder: "Company closure_Old Typo LLC" })
    expect(staffNote()!.body).toContain("Company closure_Old Typo LLC")
    expect(staffNote()!.body).not.toContain("Company closure_Italyflow LLC")
  })

  it("a company's own storage is never given a person folder by the kept-name rule", async () => {
    ;(h.single.closure_submissions as Record<string, unknown>).drive_archive_meta = { pinned_plan: { storeRootSubFolder: "Company closure_Old Typo LLC" } }
    h.resolveDest.mockResolvedValue({ folderId: "account-storage:acc-a", kind: "company", disagreement: null })
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.filePackage.mock.calls[0][0].storeRootSubFolder).toBeUndefined()
  })

  it("lists the filed files on the job (staff-only) once the filing is ok — by the owner of the files, with NO company stamped when the package is with the person (finding 14)", async () => {
    h.single.service_deliveries = { id: "sd-1", status: "active", account_id: "acc-a", notes: "" }
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.registerDocs).toHaveBeenCalledWith({ storageOwnerId: "owner-person", token: "tok-1", contactId: "contact-1", accountId: null, serviceDeliveryId: "sd-1" })
    expect(stepOf(r.results, "documents_register")).toMatchObject({ status: "ok", detail: "3 file(s) listed on the job" })
  })

  it("when the package really is with the job's company, that company is stamped on the listed files", async () => {
    h.single.service_deliveries = { id: "sd-1", status: "active", account_id: "acc-a", notes: "" }
    h.resolveDest.mockResolvedValue({ folderId: "1AbCdEfDriveFolderId", kind: "company", disagreement: null, storageOwnerId: "acc-a" })
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.registerDocs).toHaveBeenCalledWith(expect.objectContaining({ storageOwnerId: "acc-a", accountId: "acc-a" }))
  })

  it("does not list anything when the filing did not finish ok (still running or failed)", async () => {
    h.filePackage.mockResolvedValue({ step: "storage_save", status: "pending", detail: "still running" })
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(h.registerDocs).not.toHaveBeenCalled()
    expect(stepOf(r.results, "documents_register")).toBeUndefined()
  })

  it("a failure while listing the files is an error step (the setup job retries; it is idempotent) and nothing else stops", async () => {
    h.registerDocs.mockRejectedValue(new Error("db down"))
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "documents_register")).toMatchObject({ status: "error", detail: "db down" })
    expect(stepOf(r.results, "whats_new")).toBeDefined()
  })

  it("the staff note says what really happened to the filing: not filed / still being filed (finding 9)", async () => {
    h.filePackage.mockResolvedValue({ step: "storage_save", status: "error", detail: "refused" })
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(staffNote()!.body).toContain("NOT filed")
    h.inserts.length = 0
    h.filePackage.mockResolvedValue({ step: "storage_save", status: "pending", detail: "still running" })
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(staffNote()!.body).toContain("still being filed")
  })

  it("a retry of the same pass does not repeat the client-visible line (once a day) nor the staff note", async () => {
    const today = new Date().toISOString().split("T")[0]
    h.single.service_deliveries = { id: "sd-1", status: "active", account_id: null, notes: `x\n${today}: Closure form completed. Data filed.` }
    h.list.service_delivery_notes = [{ id: "n-1" }] // the same staff note is already there
    await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(clientNote()).toBeUndefined()
    expect(staffNote()).toBeUndefined()
  })

  it("a failure while writing the staff note is reported as skipped — it never fails the pass and the rest still runs", async () => {
    h.errors.service_delivery_notes = "notes table unavailable"
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "staff_note")).toMatchObject({ status: "skipped", detail: expect.stringContaining("notes table unavailable") })
    expect(stepOf(r.results, "whats_new")).toBeDefined()
    expect(stepOf(r.results, "sd_advance")).toMatchObject({ status: "ok" })
  })

  it("the happy path writes one staff note (author 'Closure wizard') and reports it ok", async () => {
    const r = await call({ submission_id: "sub-1", token: "tok-1", service_delivery_id: "sd-1" })
    expect(stepOf(r.results, "staff_note")).toMatchObject({ status: "ok" })
    expect(staffNote()).toMatchObject({ author_name: "Closure wizard" })
  })
})
