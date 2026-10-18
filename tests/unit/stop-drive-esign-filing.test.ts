/**
 * Stop Drive, slice S1c (dev job 264bb882): a signed e-sign PDF is filed in the company's storage (never Drive); a company
 * with no storage gets the bucket-served portal row; and a PDF that could not be filed ANYWHERE raises a system_errors alarm
 * and the support email must not claim it was filed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveCalls: [] as string[],
  companyState: "store" as "store" | "drive",
  saveResult: "store" as "store" | "throw",
  insertError: null as null | { message: string },
  mails: [] as string[],
  alarms: [] as Array<Record<string, unknown>>,
  stateThrows: false,
  driveMode: "forbid" as "forbid" | "record",
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  const base = h.makeSupabase(state.rows, state.recorded as never)
  // documents inserts can be made to fail
  const from = (table: string) => {
    const chain = base.from(table) as Record<string, unknown>
    if (table === "documents") {
      const insert = chain.insert as (p: unknown) => unknown
      chain.insert = (p: unknown) => { insert(p); return Promise.resolve({ error: state.insertError }) }
    }
    return chain
  }
  return { supabaseAdmin: { from, storage: base.storage } }
})
vi.mock("@/lib/google-drive", async () => (await import("./_stop-drive-mocks")).driveSpyDynamic(state.driveCalls, () => state.driveMode))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async () => ({ id: "doc-1" }) }))
vi.mock("@/lib/operations/document", () => ({ updateDocument: async () => undefined }))
vi.mock("@/lib/gmail", () => ({ gmailPost: async (_p: string, body: { raw: string }) => { state.mails.push(Buffer.from(body.raw, "base64url").toString()); return {} } }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: () => undefined }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (e: Record<string, unknown>) => { state.alarms.push(e); return null } }))
vi.mock("@/lib/portal/document-alerts", () => ({ notifyClientsOfNewDocument: async () => undefined }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => { if (state.stateThrows) throw new Error("lookup down"); return state.companyState } }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  saveSignedPdfForAccount: vi.fn(async () => {
    if (state.saveResult === "throw") throw new Error("storage down")
    return { route: "store", fileId: "f-1", pointer: "store:f-1", documentRowId: "doc-1", status: "created" }
  }),
}))

const env = { id: "env-1", token: "t", document_name: "Engagement letter", owner_account_id: "acct-1", contact_id: "c-1", signed_pdf_path: "esign/t/signed.pdf", signed_pdf_drive_id: null }

beforeEach(() => {
  state.companyState = "store"
  state.saveResult = "store"
  state.insertError = null
  state.recorded.length = 0
  state.driveCalls.length = 0
  state.stateThrows = false
  state.driveMode = "forbid"
  state.mails.length = 0
  state.alarms.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.esign_envelopes = { ...env }
  state.rows.accounts = { company_name: "Acme LLC", status: "Active", drive_folder_id: null, gdrive_folder_url: null }
})

describe("finalizeEsignCompletion — filing", () => {
  it("storage company: filed in its storage, email says filed, no alarm, zero Drive calls", async () => {
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.recorded.some((r) => r.table === "esign_envelopes" && r.op === "update")).toBe(true)
    expect(state.alarms).toEqual([])
    expect(state.mails[0]).toContain("is filed in the client's documents")
    expect(state.mails[0]).not.toContain("FILING FAILED")
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: the bucket-served portal row is written, email says filed, no Drive call", async () => {
    state.companyState = "drive"
    state.rows.documents = []
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    const ins = state.recorded.find((r) => r.table === "documents" && r.op === "insert")
    expect(ins?.payload).toMatchObject({ account_id: "acct-1", portal_visible: true, drive_file_id: "storage:signed-documents/esign/t/signed.pdf" })
    expect(state.alarms).toEqual([])
    expect(state.mails[0]).toContain("is filed in the client's documents")
    expect(state.driveCalls).toEqual([])
  })

  it("storage save fails: a system error is raised and the email does NOT say filed", async () => {
    state.saveResult = "throw"
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.alarms).toHaveLength(1)
    expect(state.alarms[0]).toMatchObject({ route: "lib/operations/esign", source: "server" })
    expect(String((state.alarms[0].context as Record<string, unknown>).reason)).toContain("storage down")
    expect(state.mails[0]).toContain("FILING FAILED")
    expect(state.mails[0]).not.toContain("is filed in the client's documents")
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company and the row insert fails: alarm raised, email says filing failed", async () => {
    state.companyState = "drive"
    state.rows.documents = []
    state.insertError = { message: "constraint boom" }
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.alarms).toHaveLength(1)
    expect(String((state.alarms[0].context as Record<string, unknown>).reason)).toContain("constraint boom")
    expect(state.mails[0]).toContain("FILING FAILED")
  })

  it("an envelope already filed (re-run) is not filed again and raises nothing", async () => {
    state.rows.esign_envelopes = { ...env, signed_pdf_drive_id: "store:old" }
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.alarms).toEqual([])
    expect(state.recorded.filter((r) => r.table === "documents")).toEqual([])
  })

  it("a company left on its old folder: the signed PDF goes there as before, no alarm", async () => {
    state.companyState = "drive"
    state.driveMode = "record"
    state.rows.accounts = { company_name: "Acme LLC", status: "Active", drive_folder_id: "OLDFOLDER", gdrive_folder_url: null }
    const { finalizeEsignCompletion } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.driveCalls).toContain("uploadBinaryToDriveUpsert")
    expect(state.alarms).toEqual([])
    expect(state.mails[0]).toContain("is filed in the client's documents")
  })

  it("the storage lookup throws: ONE clear alarm, the email says FILING FAILED, nothing is claimed — and the filing is genuinely retryable", async () => {
    state.stateThrows = true
    const { finalizeEsignCompletion, fileEsignSignedPdf } = await import("@/lib/operations/esign")
    await finalizeEsignCompletion("env-1")
    expect(state.alarms).toHaveLength(1)
    expect(String((state.alarms[0].context as Record<string, unknown>).reason)).toContain("lookup down")
    expect(state.mails[0]).toContain("FILING FAILED")
    // nothing was marked filed: no pointer written, no fallback row
    expect(state.recorded.filter((r) => r.table === "esign_envelopes" && r.op === "update")).toEqual([])
    expect(state.recorded.filter((r) => r.table === "documents")).toEqual([])
    // the reconciliation re-run (same function) files it once the lookup works
    state.stateThrows = false
    const again = await fileEsignSignedPdf("env-1")
    expect(again.filed).toBe(true)
    expect(state.recorded.some((r) => r.table === "esign_envelopes" && r.op === "update")).toBe(true)
  })

  it("filing is idempotent: the bucket-served row that already exists is a no-op that still counts as filed", async () => {
    state.companyState = "drive"
    state.rows.documents = { id: "existing" }
    const { fileEsignSignedPdf } = await import("@/lib/operations/esign")
    expect((await fileEsignSignedPdf("env-1")).filed).toBe(true)
    expect(state.recorded.filter((r) => r.table === "documents" && r.op === "insert")).toEqual([])
  })
})
