/**
 * Stop Drive, slice S1c fix round:
 *  - Calendar "Mark filed" (fileRenewal) and the flow upload agree: storage company → storage; company left on its old folder →
 *    its folder; anything else → the one sentence, before anything is written;
 *  - save-signed: a plain refusal is a 409 and raises NO system error; a real failure still does;
 *  - the lease page's regenerate: the refusal comes BEFORE the lease row is changed;
 *  - the e-sign reconciliation cron re-files completed envelopes that were not filed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveCalls: [] as string[],
  route: "drive" as "store" | "drive",
  alarms: [] as Array<Record<string, unknown>>,
  saveResult: { success: false } as Record<string, unknown>,
  refiled: [] as string[],
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/google-drive", async () => {
  const h = await import("./_stop-drive-mocks")
  return h.driveSpyDynamic(state.driveCalls, () => "record")
})
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => state.route }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class extends Error {},
  saveDocumentForAccount: vi.fn(async () => (state.route === "store" ? { route: "store", fileId: "f", pointer: "store:f", documentRowId: "d1", status: "created" } : { route: "drive" })),
}))
vi.mock("@/lib/server-action", () => ({ safeAction: async (fn: () => Promise<unknown>) => { try { return { success: true, data: await fn() } } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) } } } }))
vi.mock("@/lib/operations/service-delivery", () => ({ completeSD: vi.fn(), createSD: vi.fn() }))
vi.mock("@/lib/portal/notifications", () => ({ createPortalNotification: vi.fn() }))
vi.mock("@/lib/operations/principal-office", () => ({ applyPrincipalOfficeDecision: vi.fn() }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (e: Record<string, unknown>) => { state.alarms.push(e); return null } }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "c@x.com" } } }) } }) }))
vi.mock("@/lib/portal-auth", () => ({ getClientContactId: () => "contact-1", getClientAccountIds: async () => ["acct-1"] }))
vi.mock("@/lib/portal/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), getRateLimitKey: () => "k" }))
vi.mock("@/lib/portal/save-generated-document", () => ({ saveSignedGeneratedDocument: vi.fn(async () => state.saveResult) }))
vi.mock("@/lib/auth/staff-preview", () => ({ isStaffPreview: async () => true }))

import { NO_STORAGE_SENTENCE, CLIENT_NO_STORAGE_SENTENCE } from "@/lib/crm-store/no-storage"
import { ACCOUNT_REFUSED, ACCOUNT_CLOSED_WITH_FOLDER, ACCOUNT_OLD_FOLDER } from "./_stop-drive-mocks"

beforeEach(() => {
  state.route = "drive"
  state.recorded.length = 0
  state.driveCalls.length = 0
  state.alarms.length = 0
  state.refiled.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
})

describe("fileRenewal (Calendar 'Mark filed') — same rule as the flow upload", () => {
  const params = () => ({
    account_id: "acct-1", delivery_id: null, kind: "ra" as const, filed_date: "2026-10-01",
    receipt: { file_name: "r.pdf", mime_type: "application/pdf", data: Buffer.from("%PDF") },
  })
  const account = (extra: Record<string, unknown>) => ({ id: "acct-1", company_name: "Acme LLC", state_of_formation: "WY", portal_tier: "active", notes: "", ra_renewal_date: "2026-10-01", annual_report_due_date: null, ...extra })

  it("no storage and no folder: the one sentence, before anything is written", async () => {
    state.rows.accounts = account(ACCOUNT_REFUSED)
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    const r = await fileRenewal(params())
    expect(r).toEqual({ success: false, error: NO_STORAGE_SENTENCE })
    expect(state.driveCalls).toEqual([])
    expect(state.recorded).toEqual([])
  })
  it("a Closed company with a folder is refused too", async () => {
    state.rows.accounts = account(ACCOUNT_CLOSED_WITH_FOLDER)
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    expect((await fileRenewal(params())).error).toBe(NO_STORAGE_SENTENCE)
    expect(state.driveCalls).toEqual([])
  })
  it("a company left on its old folder: the receipt goes to its folder (Compliance), as before", async () => {
    state.rows.accounts = account(ACCOUNT_OLD_FOLDER)
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    await fileRenewal(params())
    expect(state.driveCalls).toContain("ensureDrivePath")
    expect(state.driveCalls).toContain("uploadBinaryToDriveUpsert")
  })
})

describe("save-signed route", () => {
  const req = () => {
    const f = new FormData()
    f.set("file", new File(["%PDF"], "doc.pdf", { type: "application/pdf" }))
    f.set("account_id", "acct-1")
    return new NextRequest("http://localhost/x", { method: "POST", body: f })
  }
  it("a plain refusal → 409 with the CLIENT sentence (no staff wording) and NO system error", async () => {
    state.saveResult = { success: false, error: NO_STORAGE_SENTENCE, refused: true }
    const { POST } = await import("@/app/api/portal/generated-documents/save-signed/route")
    const res = await POST(req())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: CLIENT_NO_STORAGE_SENTENCE })
    expect(state.alarms).toEqual([])
  })
  it("a real failure → 500 and a system error, as before", async () => {
    state.saveResult = { success: false, error: "Save failed: boom" }
    const { POST } = await import("@/app/api/portal/generated-documents/save-signed/route")
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(state.alarms).toHaveLength(1)
  })
})

describe("lease regenerate (page) — refusal before the lease row changes", () => {
  const regen = async () => {
    const { POST } = await import("@/app/api/lease/[token]/regen/route")
    return POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pdf_path: "tok/new.pdf" }) }), { params: Promise.resolve({ token: "tok" }) })
  }
  beforeEach(() => { state.rows.lease_agreements = { id: "lease-1", account_id: "acct-1" } })

  it("a company that can receive no file: 409 with the sentence and the lease row is NOT updated", async () => {
    state.rows.accounts = ACCOUNT_REFUSED
    const res = await regen()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NO_STORAGE_SENTENCE })
    expect(state.recorded.filter((r) => r.table === "lease_agreements")).toEqual([])
  })
  it("a storage company: the lease row is updated", async () => {
    state.route = "store"
    const res = await regen()
    expect(res.status).toBe(200)
    expect(state.recorded.find((r) => r.table === "lease_agreements" && r.op === "update")?.payload).toEqual({ pdf_storage_path: "tok/new.pdf" })
  })
  it("a company left on its old folder: the lease row is updated (its folder takes the copy)", async () => {
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    const res = await regen()
    expect(res.status).toBe(200)
  })
})
