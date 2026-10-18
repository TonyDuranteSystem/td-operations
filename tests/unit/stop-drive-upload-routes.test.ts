/**
 * Stop Drive, slice S1c (dev job 264bb882): the upload / regenerate routes no longer need a Drive folder.
 *
 * For each route: (a) a company with storage → the file lands in the CRM storage with the right type / visibility and Google
 * Drive is never called; (b) a company with NO storage → ONE plain sentence (409), nothing saved, Drive never called.
 * Google Drive is a spy that fails the test when touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { MovingError } = vi.hoisted(() => ({ MovingError: class MovingError extends Error {} }))
const state = vi.hoisted(() => ({
  moving: false,
  movingMidSave: false,
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveCalls: [] as string[],
  route: "store" as "store" | "drive",
  saves: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  driveMode: "forbid" as "forbid" | "record",
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never, { removed: state.removed }) }
})
vi.mock("@/lib/google-drive", async () => {
  const h = await import("./_stop-drive-mocks")
  return h.driveSpyDynamic(state.driveCalls, () => state.driveMode)
})
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => (state.moving ? "moving" : state.route === "store" ? "store" : "drive") }))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async () => ({ id: "doc-drive-1" }) }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", app_metadata: { role: "admin" }, user_metadata: {}, email: "staff@tonydurante.us" } } }) } }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))
vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/portal/team/gate", () => ({ canAccessAccount: async () => true }))
vi.mock("@/lib/portal/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), getRateLimitKey: () => "k" }))
vi.mock("@/lib/portal-auth", () => ({ getClientContactId: () => "contact-1" }))
vi.mock("@/lib/portal/chat-events", () => ({ emitDocumentUploadedEvent: async () => undefined }))
vi.mock("@/lib/portal/audit", () => ({ logPortalAction: () => undefined }))
vi.mock("@/lib/portal/document-alerts", () => ({ notifyClientsOfNewDocument: async () => undefined }))
vi.mock("@/lib/lease-pdf", () => ({ generateLeasePDF: async () => new Uint8Array([37, 80, 68, 70]) }))
vi.mock("@/lib/dba-ocr", () => ({ extractDbaFieldsFromOcr: () => ({}) }))
vi.mock("@/lib/crm-store/ocr", () => ({ ocrByPointer: async () => ({ fullText: "" }) }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: MovingError,
  saveDocumentForAccount: vi.fn(async (input: Record<string, unknown>) => {
    state.saves.push(input)
    if (state.moving) throw new MovingError("This company's files are being moved to the new storage right now — please try again in a few minutes.")
    return state.route === "store"
      ? { route: "store", fileId: "f-1", pointer: "store:f-1", documentRowId: "doc-1", status: "created" }
      : { route: "drive" }
  }),
  saveSignedPdfForAccount: vi.fn(async (input: Record<string, unknown>) => {
    if (state.movingMidSave) throw new MovingError("This company's files are being moved to the new storage right now — please try again in a few minutes.")
    state.saves.push(input)
    return state.route === "store"
      ? { route: "store", fileId: "f-1", pointer: "store:f-1", documentRowId: "doc-1", status: "created" }
      : { route: "drive" }
  }),
}))
vi.mock("@/lib/crm-store/save-form", () => ({
  saveTaskFileForAccount: vi.fn(async (input: Record<string, unknown>) => {
    state.saves.push(input)
    return state.route === "store" ? { route: "store", fileId: "f-1", pointer: "store:f-1", status: "created" } : { route: "drive" }
  }),
}))

import { NO_STORAGE_SENTENCE, CLIENT_NO_STORAGE_SENTENCE } from "@/lib/crm-store/no-storage"
import { ACCOUNT_REFUSED, ACCOUNT_CLOSED_WITH_FOLDER, ACCOUNT_OLD_FOLDER } from "./_stop-drive-mocks"

const json = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => {
  state.route = "store"
  state.recorded.length = 0
  state.driveCalls.length = 0
  state.saves.length = 0
  state.removed.length = 0
  state.moving = false
  state.movingMidSave = false
  state.driveMode = "forbid"
  for (const k of Object.keys(state.rows)) delete state.rows[k]
})

describe("portal documents upload", () => {
  const body = { account_id: "acct-1", storage_path: "p/x.pdf", file_name: "x.pdf", mime_type: "application/pdf", doc_type: "Bank statement", category: "4" }

  it("storage company: saved in the storage, hidden from the client, typed other_document, zero Drive calls", async () => {
    const { POST } = await import("@/app/api/portal/documents/upload/route")
    const res = await POST(json(body))
    expect(res.status).toBe(200)
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", folder: "banking", documentType: "other_document", name: "x.pdf" })
    expect(state.saves[0].portalVisible).toBeUndefined() // default false: hidden until staff review
    expect((await res.json()).document_id).toBe("doc-1")
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: one plain sentence, nothing saved, zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_REFUSED
    const { POST } = await import("@/app/api/portal/documents/upload/route")
    const res = await POST(json(body))
    expect(res.status).toBe(409)
    // a CLIENT never sees the staff wording
    expect(await res.json()).toEqual({ error: CLIENT_NO_STORAGE_SENTENCE })
    expect(CLIENT_NO_STORAGE_SENTENCE).toBe("We could not save this file. Please contact us.")
    expect(state.recorded.filter((r) => r.table === "documents")).toEqual([])
    expect(state.driveCalls).toEqual([])
    // the refused upload leaves nothing behind in the upload bucket
    expect(state.removed).toContain("portal-uploads/p/x.pdf")
  })

  it("a Closed company that still has a folder is refused too (no Drive write), staged file removed", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_CLOSED_WITH_FOLDER
    const { POST } = await import("@/app/api/portal/documents/upload/route")
    const res = await POST(json(body))
    expect(res.status).toBe(409)
    expect(state.driveCalls).toEqual([])
    expect(state.removed).toContain("portal-uploads/p/x.pdf")
  })

  it("a company left on its old folder (Active, folder, no storage) carries on exactly as before: uploaded there, record written", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    state.rows.documents = { id: "doc-drive-1" }
    const { POST } = await import("@/app/api/portal/documents/upload/route")
    const res = await POST(json(body))
    expect(res.status).toBe(200)
    expect(state.driveCalls).toEqual(["uploadBinaryToDrive"])
    const ins = state.recorded.find((r) => r.table === "documents" && r.op === "insert")
    expect(ins?.payload).toMatchObject({ account_id: "acct-1", drive_file_id: "drive-file-1", status: "classified" })
  })
})

describe("workflow task file upload", () => {
  const form = () => {
    const f = new FormData()
    f.set("file", new File(["hello"], "letter.pdf", { type: "application/pdf" }))
    f.set("task_id", "task-1")
    f.set("subfolder", "ITIN/IRS Letters")
    return new NextRequest("http://localhost/x", { method: "POST", body: f })
  }
  beforeEach(() => {
    state.rows.tasks = { id: "task-1", account_id: "acct-1", contact_id: null }
    state.rows.accounts = { id: "acct-1", company_name: "Acme LLC" }
  })

  it("storage company: pointer returned, saved under the named sub-folder, zero Drive calls", async () => {
    const { POST } = await import("@/app/api/workflows/upload-task-file/route")
    const res = await POST(form())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ file_id: "store:f-1", file_name: "letter.pdf", drive_url: null })
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", subfolder: "ITIN/IRS Letters" })
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: one plain sentence (409), zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_REFUSED
    const { POST } = await import("@/app/api/workflows/upload-task-file/route")
    const res = await POST(form())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
  })

  it("a company left on its old folder: uploaded there under the sub-folder chain, the old link shape returned", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = { id: "acct-1", company_name: "Acme LLC", ...ACCOUNT_OLD_FOLDER }
    const { POST } = await import("@/app/api/workflows/upload-task-file/route")
    const res = await POST(form())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ file_id: "drive-file-1", drive_url: "https://drive.google.com/file/d/drive-file-1/view" })
    expect(state.driveCalls).toContain("uploadBinaryToDrive")
  })

  it("the stored-file answer (drive_url null) is what the workflow upload field handles: it only reads file_id / file_name", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("components/tasks/action-confirm-modal.tsx", "utf8")
    const at = src.indexOf("fetch('/api/workflows/upload-task-file'")
    const handler = src.slice(at, at + 900)
    expect(handler).toContain("body.file_id")
    expect(src).not.toMatch(/body\.drive_url|\.drive_url\b/)
  })
})

describe("lease regeneration routes", () => {
  beforeEach(() => {
    state.rows.lease_agreements = { id: "lease-1", token: "tok", tenant_company: "Acme LLC", suite_number: "12", account_id: "acct-1", status: "signed", signed_at: "2026-01-02T00:00:00Z", pdf_storage_path: "tok/signed.pdf", template_version: 1, effective_date: "2026-01-02", term_start_date: "2026-01-02", term_end_date: "2027-01-01", tenant_contact_name: "A B" }
  })

  it("regen-lease-pdf, storage company: saved as the office lease (new version), zero Drive calls", async () => {
    const { POST } = await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")
    const res = await POST(json({ lease_id: "lease-1" }))
    expect(res.status).toBe(200)
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", documentType: "office_lease", callerKey: "lease-signed:lease-1" })
    expect(state.driveCalls).toEqual([])
  })

  it("regen-lease-pdf, no-storage company: one plain sentence (409), zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_REFUSED
    const { POST } = await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")
    const res = await POST(json({ lease_id: "lease-1" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
    // decided before anything is built or stored: the lease row is untouched
    expect(state.recorded.filter((r) => r.table === "lease_agreements")).toEqual([])
  })

  it("regen-lease-pdf, company left on its old folder: re-uploaded there as before", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    state.rows.documents = null
    const { POST } = await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")
    const res = await POST(json({ lease_id: "lease-1" }))
    expect(res.status).toBe(200)
    expect(state.driveCalls).toContain("uploadBinaryToDriveUpsert")
  })

  it("lease-regen-drive, storage company: filed, zero Drive calls", async () => {
    const { POST } = await import("@/app/api/lease-regen-drive/route")
    const res = await POST(json({ lease_id: "lease-1", token: "tok" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, driveFileId: "store:f-1" })
    expect(state.saves[0]).toMatchObject({ documentType: "office_lease", callerKey: "lease-signed:lease-1" })
    expect(state.driveCalls).toEqual([])
  })

  it("lease-regen-drive, no-storage company: one plain sentence (409), zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_REFUSED
    const { POST } = await import("@/app/api/lease-regen-drive/route")
    const res = await POST(json({ lease_id: "lease-1", token: "tok" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
  })

  it("lease-regen-drive, company left on its old folder: carries on there", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    const { POST } = await import("@/app/api/lease-regen-drive/route")
    const res = await POST(json({ lease_id: "lease-1", token: "tok" }))
    expect(res.status).toBe(200)
    expect(state.driveCalls).toContain("uploadBinaryToDriveUpsert")
  })
})

describe("staff account document upload", () => {
  const body = { account_id: "acct-1", storage_path: "p/x.pdf", file_name: "x.pdf", mime_type: "application/pdf", document_type: "Other", category: "Tax" }
  beforeEach(() => { state.rows.accounts = { company_name: "Acme LLC" } })

  it("storage company: saved in the tax folder, hidden unless chosen, zero Drive calls", async () => {
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(json(body))
    expect((await res.json()).success).toBe(true)
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", folder: "tax", portalVisible: false })
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: one plain sentence (409), zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED }
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(json(body))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, detail: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
    expect(state.removed).toContain("onboarding-uploads/p/x.pdf")
  })

  it("company left on its old folder: uploaded there as before", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_OLD_FOLDER }
    state.rows.documents = []
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(json(body))
    expect((await res.json()).success).toBe(true)
    expect(state.driveCalls).toContain("uploadBinaryToDrive")
  })
})

describe("DBA document upload", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/accounts/[id]/dba/[dbaId]/upload-document/route")
    return POST(json({ storage_path: "p/dba.pdf", file_name: "dba.pdf", mime_type: "application/pdf" }), { params: { id: "acct-1", dbaId: "dba-1" } })
  }
  beforeEach(() => {
    state.rows.dba_details = { id: "dba-1", delivery_id: "sd-1", filed_date: null, registration_number: null }
    state.rows.service_deliveries = { id: "sd-1", account_id: "acct-1" }
    state.rows.documents = []
  })

  it("storage company: saved as a portal-visible DBA Application in the company folder, zero Drive calls", async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", folder: "company", portalVisible: true })
    expect(state.saves[0].row).toMatchObject({ document_type_name: "DBA Application" })
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: one plain sentence (409), zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = ACCOUNT_REFUSED
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, detail: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
    expect(state.removed).toContain("onboarding-uploads/p/dba.pdf")
  })

  it("company left on its old folder: uploaded there as before", async () => {
    state.route = "drive"
    state.driveMode = "record"
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    const res = await call()
    expect(res.status).toBe(200)
    expect(state.driveCalls).toContain("uploadBinaryToDrive")
  })
})

describe("a company being moved is a TRANSIENT refusal: the staged file is kept so 'try again' works", () => {
  it("portal upload", async () => {
    state.moving = true
    const { POST } = await import("@/app/api/portal/documents/upload/route")
    const res = await POST(json({ account_id: "acct-1", storage_path: "p/x.pdf", file_name: "x.pdf", mime_type: "application/pdf", category: "4" }))
    expect(res.status).toBe(409)
    expect(state.removed).toEqual([])
  })
  it("staff account document", async () => {
    state.moving = true
    state.rows.accounts = { company_name: "Acme LLC" }
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(json({ account_id: "acct-1", storage_path: "p/x.pdf", file_name: "x.pdf", mime_type: "application/pdf", category: "Tax" }))
    expect(res.status).toBe(409)
    expect(state.removed).toEqual([])
  })
  it("DBA document", async () => {
    state.moving = true
    state.rows.dba_details = { id: "dba-1", delivery_id: "sd-1", filed_date: null, registration_number: null }
    state.rows.service_deliveries = { id: "sd-1", account_id: "acct-1" }
    const { POST } = await import("@/app/api/accounts/[id]/dba/[dbaId]/upload-document/route")
    const res = await POST(json({ storage_path: "p/dba.pdf", file_name: "dba.pdf", mime_type: "application/pdf" }), { params: { id: "acct-1", dbaId: "dba-1" } })
    expect(res.status).toBe(409)
    expect(state.removed).toEqual([])
  })
})

describe("a company being MOVED on the lease routes: a clean 409 'try again', never a 500, and nothing is half-changed", () => {
  const MOVING = "This company's files are being moved to the CRM storage right now — please try again in a few minutes."
  beforeEach(() => {
    state.rows.lease_agreements = { id: "lease-1", token: "tok", tenant_company: "Acme LLC", suite_number: "12", account_id: "acct-1", status: "signed", signed_at: "2026-01-02T00:00:00Z", pdf_storage_path: "tok/signed.pdf", template_version: 1, effective_date: "2026-01-02", term_start_date: "2026-01-02", term_end_date: "2027-01-01", tenant_contact_name: "A B" }
  })
  it("regen-lease-pdf: refused up front (nothing built, nothing stored, lease row untouched)", async () => {
    state.moving = true
    const { POST } = await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")
    const res = await POST(json({ lease_id: "lease-1" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(MOVING)
    expect(state.recorded.filter((r) => r.table === "lease_agreements")).toEqual([])
  })
  it("regen-lease-pdf: the company starts moving DURING the save → still a clean 409", async () => {
    state.movingMidSave = true
    const { POST } = await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")
    const res = await POST(json({ lease_id: "lease-1" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("try again in a few minutes")
    expect(state.recorded.filter((r) => r.table === "lease_agreements")).toEqual([])
    // the regenerated copy that was already uploaded to the lease bucket is removed, not left behind
    expect(state.removed.some((x) => x.includes("lease-signed-regen-"))).toBe(true)
  })
  it("lease-regen-drive: a clean 409, never a 500", async () => {
    state.movingMidSave = true
    const { POST } = await import("@/app/api/lease-regen-drive/route")
    const res = await POST(json({ lease_id: "lease-1", token: "tok" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("try again in a few minutes")
  })
})

describe("flow upload for a company left on its old folder (folder, no storage) — consistent with the other routes", () => {
  it("the decision helper is the single rule: Active + folder → its folder; Closed/Cancelled/no folder → refused", async () => {
    const { decideNoStorage } = await import("@/lib/crm-store/no-storage")
    expect(decideNoStorage(ACCOUNT_OLD_FOLDER).route).toBe("drive")
    expect(decideNoStorage(ACCOUNT_CLOSED_WITH_FOLDER).route).toBe("refuse")
    expect(decideNoStorage(ACCOUNT_REFUSED).route).toBe("refuse")
  })
})
