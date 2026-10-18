/**
 * app/api/flows/[id]/upload-document — END-TO-END route test: the EIN-letter "file into 1. Company + auto-rename"
 * feature (Luca, 2026-07-17), now that every company upload goes to the CRM STORAGE (Stop Drive, dev job 264bb882, S1c).
 *
 * Drives the REAL route handler with only the I/O boundaries mocked (Supabase + the storage save + advanceServiceDelivery).
 * Google Drive is SPIED: any call to it fails the test — a storage company must produce zero Drive calls, and a company with
 * no storage must get one plain sentence (409) with nothing saved and the stage not advanced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mutable per-test state ──────────────────────────────────────────────────
let sdRow: Record<string, unknown> | null
let accountRow: Record<string, unknown> | null
let companyState: "drive" | "store"
let saveCalls: Array<Record<string, unknown>>
let existingDocs: Array<{ id: string }>
let docInsertError: { message: string } | null

let documentsInsertPayload: Record<string, unknown> | null
let actionLogPayload: Record<string, unknown> | null
let driveCalls: string[]
let advanceCalled: boolean

// ── Mock the I/O boundaries ─────────────────────────────────────────────────
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "service_deliveries") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: sdRow, error: sdRow ? null : { message: "not found" } }),
            }),
          }),
        }
      }
      if (table === "accounts") {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: accountRow, error: null }) }) }),
        }
      }
      if (table === "documents") {
        return {
          select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: existingDocs }) }) }),
          insert: (payload: Record<string, unknown>) => {
            if (!docInsertError) documentsInsertPayload = payload
            return Promise.resolve({ error: docInsertError })
          },
        }
      }
      if (table === "action_log") {
        return {
          insert: (payload: Record<string, unknown>) => {
            actionLogPayload = payload
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    storage: {
      from: () => ({
        download: () =>
          Promise.resolve({
            data: { arrayBuffer: async () => new TextEncoder().encode("PDFDATA").buffer, type: "application/pdf" },
            error: null,
          }),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://signed.example/url" } }),
        remove: () => Promise.resolve({}),
      }),
    },
  },
}))

// Google Drive is a SPY: nothing here may ever call it.
vi.mock("@/lib/google-drive", () => {
  const spy = (name: string) => vi.fn(async () => { driveCalls.push(name); throw new Error(`Drive must not be called: ${name}`) })
  return { listFolderAnyDrive: spy("listFolderAnyDrive"), listFolder: spy("listFolder"), createFolder: spy("createFolder"), uploadBinaryToDrive: spy("uploadBinaryToDrive"), uploadBinaryToDriveUpsert: spy("uploadBinaryToDriveUpsert") }
})

vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: vi.fn(async () => companyState), liveOwnerOfContact: vi.fn(async () => null) }))

vi.mock("@/lib/crm-store/formation-pilot", () => ({
  pilotSaveFormationUpload: vi.fn(async () => ({ status: "not_pilot" })),
  FORMATION_UPLOAD_TYPES: {},
}))

vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class extends Error {},
  saveDocumentForAccount: vi.fn(async (input: Record<string, unknown>) => {
    saveCalls.push(input)
    return { route: "store", fileId: "f-1", pointer: "store:f-1", documentRowId: "doc-1", status: "created" }
  }),
  saveDocumentForContact: vi.fn(async () => ({ route: "drive" })),
}))

vi.mock("@/lib/service-delivery", () => ({
  advanceServiceDelivery: vi.fn(async () => {
    advanceCalled = true
    return { success: true, to_stage: "done", is_completed: false }
  }),
}))

vi.mock("@/lib/system-errors", () => ({ reportSystemError: vi.fn() }))

// This route is staff-only (requireStaffRoute) — the route E2E drives real auth,
// so it needs a real staff identity mocked in, same as require-staff-route.test.ts.
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "staff-1", app_metadata: { role: "admin" }, user_metadata: {}, email: "staff@tonydurante.us" } } }) },
  }),
}))

import { POST } from "@/app/api/flows/[id]/upload-document/route"

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/flows/sd-1/upload-document", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const call = (body: unknown) =>
  POST(makeReq(body) as Parameters<typeof POST>[0], { params: { id: "sd-1" } })

const EIN_BODY = {
  storage_path: "flow-uploads/sd-1/123_cp575_scan.pdf",
  file_name: "cp575_scan.pdf",
  mime_type: "application/pdf",
  flow_stage: "EIN Received",
  folder: "1. Company",
  rename: "EIN Official – {company_name}",
}

beforeEach(() => {
  delete process.env.SANDBOX_MODE
  companyState = "store"
  saveCalls = []
  sdRow = {
    id: "sd-1",
    account_id: "acct-1",
    contact_id: "cont-1",
    stage: "EIN Received",
    service_type: "Company Formation",
  }
  accountRow = { company_name: "Acme Holdings LLC", entity_type: "Single Member LLC" }
  existingDocs = []
  docInsertError = null
  documentsInsertPayload = null
  actionLogPayload = null
  driveCalls = []
  advanceCalled = false
})

describe("EIN letter upload — storage filing + auto-rename (route E2E)", () => {
  it("Scenario 1 — a storage company: saved in its '1. Company' storage under the renamed name, internal, zero Drive calls", async () => {
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0]).toMatchObject({ accountId: "acct-1", name: "EIN Official – Acme Holdings LLC.pdf", folder: "company", portalVisible: false, mimeType: "application/pdf" })
    expect(saveCalls[0].row).toMatchObject({ service_delivery_id: "sd-1", flow_stage: "EIN Received", status: "classified" })
    expect(driveCalls).toEqual([])
    expect(advanceCalled).toBe(true)
  })

  it("Scenario 2 — a '3. Tax' target lands in the tax storage folder", async () => {
    await call({ ...EIN_BODY, folder: "3. Tax" })
    expect(saveCalls[0].folder).toBe("tax")
    expect(driveCalls).toEqual([])
  })

  it("Scenario 3 — a dotless upload name produces no garbage extension", async () => {
    await call({ ...EIN_BODY, file_name: "IMG_2043" })
    expect(saveCalls[0].name).toBe("EIN Official – Acme Holdings LLC")
  })

  it("Scenario 4 — missing company name → keeps the original filename (no 'null')", async () => {
    accountRow = { company_name: null, entity_type: null }
    await call(EIN_BODY)
    expect(saveCalls[0].name).toBe("cp575_scan.pdf")
  })

  it("Scenario 5 — OTHER upload stage (no folder/rename) keeps the original name and goes to '1. Company'", async () => {
    const res = await call({
      storage_path: "flow-uploads/sd-1/9_receipt.pdf",
      file_name: "fax_receipt.pdf",
      mime_type: "application/pdf",
      flow_stage: "SS-4 Signed",
    })
    expect(res.status).toBe(200)
    expect(saveCalls[0]).toMatchObject({ name: "fax_receipt.pdf", folder: "company" })
    expect(driveCalls).toEqual([])
  })

  it("Scenario 6 — a company with NO storage: one plain sentence (409), nothing saved, no document row, stage not advanced, zero Drive calls", async () => {
    companyState = "drive"
    const res = await call(EIN_BODY)
    expect(res.status).toBe(409)
    const body = await res.json()
    const { NO_STORAGE_SENTENCE } = await import("@/lib/crm-store/no-storage")
    expect(body).toEqual({ success: false, detail: NO_STORAGE_SENTENCE })
    expect(saveCalls).toEqual([])
    expect(documentsInsertPayload).toBeNull()
    expect(advanceCalled).toBe(false)
    expect(driveCalls).toEqual([])
  })

  it("Scenario 7 — a flow with no company yet keeps the file in the upload bucket (renamed row), zero Drive calls", async () => {
    sdRow = { ...(sdRow as object), account_id: null, service_type: "Company Formation" }
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    expect(driveCalls).toEqual([])
    expect(saveCalls).toEqual([])
    expect(documentsInsertPayload?.file_name).toBe("cp575_scan.pdf")
    expect(documentsInsertPayload?.drive_file_id).toContain("storage:")
  })

  it("Scenario 8 — idempotency: an already-registered storage file is not re-inserted", async () => {
    existingDocs = [{ id: "doc-existing" }]
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    expect(documentsInsertPayload).toBeNull()
  })

  it("Scenario 9 — the audit log + response report the renamed name, keeping the original for trace", async () => {
    const res = await call(EIN_BODY)
    const body = await res.json()
    expect(body.detail).toContain("EIN Official – Acme Holdings LLC.pdf")
    expect(actionLogPayload?.summary).toContain("EIN Official – Acme Holdings LLC.pdf")
    expect((actionLogPayload?.details as Record<string, unknown>)?.original_file_name).toBe("cp575_scan.pdf")
  })
})
