/**
 * app/api/flows/[id]/upload-document — END-TO-END route test for the EIN-letter
 * "file into 1. Company + auto-rename" feature (Luca, 2026-07-17).
 *
 * Drives the REAL route handler with only the I/O boundaries mocked (Supabase +
 * Google Drive + advanceServiceDelivery). lib/flows/flow-drive-folder and
 * lib/template-interpolation run for real, so every decision branch actually
 * executes — including the Drive folder-targeting and upsert paths that a
 * sandbox deploy can NEVER reach (SANDBOX_MODE short-circuits Drive to the
 * storage fallback). Each `it` = one scenario from the Council review.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const FOLDER_MIME = "application/vnd.google-apps.folder"

// ── Mutable per-test state ──────────────────────────────────────────────────
let sdRow: Record<string, unknown> | null
let accountRow: Record<string, unknown> | null
let driveListing: { files: Array<{ id: string; name: string; mimeType: string }> }
let existingDocs: Array<{ id: string }>
let docInsertError: { message: string } | null

let documentsInsertPayload: Record<string, unknown> | null
let actionLogPayload: Record<string, unknown> | null
let driveCalls: Array<{ fn: "create" | "upsert"; name: string; folderId: string }>
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

vi.mock("@/lib/google-drive", () => ({
  listFolderAnyDrive: vi.fn(async () => driveListing),
  uploadBinaryToDrive: vi.fn(async (name: string, _b: Buffer, _m: string, folderId: string) => {
    driveCalls.push({ fn: "create", name, folderId })
    return { id: "drive-created", name }
  }),
  uploadBinaryToDriveUpsert: vi.fn(async (name: string, _b: Buffer, _m: string, folderId: string) => {
    driveCalls.push({ fn: "upsert", name, folderId })
    return { id: "drive-upsert", name, action: "overwritten" }
  }),
}))

vi.mock("@/lib/service-delivery", () => ({
  advanceServiceDelivery: vi.fn(async () => {
    advanceCalled = true
    return { success: true, to_stage: "done", is_completed: false }
  }),
}))

vi.mock("@/lib/system-errors", () => ({ reportSystemError: vi.fn() }))

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
  delete process.env.SANDBOX_MODE // default: production-like (Drive path runs)
  sdRow = {
    id: "sd-1",
    account_id: "acct-1",
    contact_id: "cont-1",
    stage: "EIN Received",
    service_type: "Company Formation",
  }
  accountRow = { drive_folder_id: "ROOTFOLDER", gdrive_folder_url: null, company_name: "Acme Holdings LLC", entity_type: "Single Member LLC" }
  driveListing = { files: [{ id: "sub-company", name: "1. Company", mimeType: FOLDER_MIME }] }
  existingDocs = []
  docInsertError = null
  documentsInsertPayload = null
  actionLogPayload = null
  driveCalls = []
  advanceCalled = false
})

describe("EIN letter upload — folder targeting + auto-rename (route E2E)", () => {
  it("Scenario 1 — files into '1. Company' and renames using the company name", async () => {
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    expect(driveCalls).toEqual([
      { fn: "upsert", name: "EIN Official – Acme Holdings LLC.pdf", folderId: "sub-company" },
    ])
    expect(documentsInsertPayload?.file_name).toBe("EIN Official – Acme Holdings LLC.pdf")
    expect(advanceCalled).toBe(true)
  })

  it("Scenario 2 — subfolder absent → falls back to the account root, still renamed", async () => {
    driveListing = { files: [{ id: "sub-tax", name: "3. Tax", mimeType: FOLDER_MIME }] }
    await call(EIN_BODY)
    expect(driveCalls).toEqual([
      { fn: "upsert", name: "EIN Official – Acme Holdings LLC.pdf", folderId: "ROOTFOLDER" },
    ])
    expect(documentsInsertPayload?.file_name).toBe("EIN Official – Acme Holdings LLC.pdf")
  })

  it("Scenario 3 — matches a legacy folder name case/space-insensitively", async () => {
    driveListing = { files: [{ id: "sub-legacy", name: "  1. COMPANY ", mimeType: FOLDER_MIME }] }
    await call(EIN_BODY)
    expect(driveCalls[0].folderId).toBe("sub-legacy")
  })

  it("Scenario 4 — a same-named folder ENTRY that is a file (not a folder) is ignored → root fallback", async () => {
    driveListing = { files: [{ id: "not-a-folder", name: "1. Company", mimeType: "application/pdf" }] }
    await call(EIN_BODY)
    expect(driveCalls[0].folderId).toBe("ROOTFOLDER")
  })

  it("Scenario 5 — a dotless upload name produces no garbage extension", async () => {
    await call({ ...EIN_BODY, file_name: "IMG_2043" })
    expect(driveCalls[0].name).toBe("EIN Official – Acme Holdings LLC")
    expect(documentsInsertPayload?.file_name).toBe("EIN Official – Acme Holdings LLC")
  })

  it("Scenario 6 — missing company name → keeps the original filename (no 'null')", async () => {
    accountRow = { drive_folder_id: "ROOTFOLDER", gdrive_folder_url: null, company_name: null, entity_type: null }
    await call(EIN_BODY)
    expect(driveCalls[0].name).toBe("cp575_scan.pdf")
    expect(documentsInsertPayload?.file_name).toBe("cp575_scan.pdf")
  })

  it("Scenario 7 — OTHER upload stage (no folder/rename) is untouched: root folder, original name, plain create", async () => {
    const res = await call({
      storage_path: "flow-uploads/sd-1/9_receipt.pdf",
      file_name: "fax_receipt.pdf",
      mime_type: "application/pdf",
      flow_stage: "SS-4 Signed",
    })
    expect(res.status).toBe(200)
    expect(driveCalls).toEqual([{ fn: "create", name: "fax_receipt.pdf", folderId: "ROOTFOLDER" }])
    expect(documentsInsertPayload?.file_name).toBe("fax_receipt.pdf")
  })

  it("Scenario 8 — sandbox (Drive mocked) storage fallback still renames the documents row", async () => {
    process.env.SANDBOX_MODE = "1"
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    // No Drive upload at all in sandbox …
    expect(driveCalls).toEqual([])
    // … but the renamed name lands on the documents row (the only thing sandbox QA can see).
    expect(documentsInsertPayload?.file_name).toBe("EIN Official – Acme Holdings LLC.pdf")
    expect(documentsInsertPayload?.drive_file_id).toContain("storage:")
  })

  it("Scenario 9 — idempotency: an already-registered file is not re-inserted", async () => {
    existingDocs = [{ id: "doc-existing" }]
    const res = await call(EIN_BODY)
    expect(res.status).toBe(200)
    expect(documentsInsertPayload).toBeNull() // insert skipped
    // Drive upload still happens (upsert overwrites in place), no duplicate row.
    expect(driveCalls[0].fn).toBe("upsert")
  })

  it("Scenario 10 — the audit log + response report the renamed name, keeping the original for trace", async () => {
    const res = await call(EIN_BODY)
    const body = await res.json()
    expect(body.detail).toContain("EIN Official – Acme Holdings LLC.pdf")
    expect(actionLogPayload?.summary).toContain("EIN Official – Acme Holdings LLC.pdf")
    expect((actionLogPayload?.details as Record<string, unknown>)?.original_file_name).toBe("cp575_scan.pdf")
  })
})
