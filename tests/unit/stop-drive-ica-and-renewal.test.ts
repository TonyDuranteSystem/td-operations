/**
 * Stop Drive S1d (dev job 264bb882): the intercompany agreement and the Calendar's "Mark filed" receipt.
 * A Closed / Cancelled company or a company with no folder gets an ERROR (and an alarm) — never a Drive write, never a false "saved".
 * A company left on Drive (folder, no storage, not closed) is still filed in Drive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveWrites: [] as string[],
  driveReads: [] as string[],
  companyState: "drive" as "store" | "drive" | "moving",
  alarms: [] as Array<{ kind: string; details: Record<string, unknown> }>,
}))

vi.mock("@/lib/supabase-admin", async () => ({ supabaseAdmin: (await import("./_legacy-drive-mocks")).makeSupabase(st.rows, st.recorded as never) }))
vi.mock("@/lib/google-drive", async () => (await import("./_legacy-drive-mocks")).driveSpy(st.driveWrites, st.driveReads, { writesSucceed: true }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => st.companyState }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: async (kind: string, details: Record<string, unknown>) => { st.alarms.push({ kind, details }) } }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  saveSignedPdfForAccount: async () => (st.companyState === "store" ? { route: "store", fileId: "f1", pointer: "store:f1", documentRowId: "doc-1", status: "created" } : { route: "drive" }),
  saveDocumentForAccount: async () => (st.companyState === "store" ? { route: "store", fileId: "f1", pointer: "store:f1", documentRowId: "doc-1", status: "created" } : { route: "drive" }),
}))
vi.mock("@/lib/pdf/intercompany-agreement-pdf", () => ({ generateIntercompanyAgreementPDF: async () => new Uint8Array([37, 80, 68, 70]) }))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async () => ({ id: "d1" }) }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: () => {} }))
vi.mock("@/lib/server-action", () => ({
  safeAction: async (fn: () => Promise<unknown>) => { try { return { success: true, data: await fn() } } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) } } },
}))
vi.mock("@/lib/operations/service-delivery", () => ({ completeSD: async () => ({}), createSD: async () => ({ id: "sd-1" }) }))
vi.mock("@/lib/portal/notifications", () => ({ createPortalNotification: async () => ({}) }))

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  st.recorded.length = 0; st.driveWrites.length = 0; st.driveReads.length = 0; st.alarms.length = 0
  st.companyState = "drive"
  for (const k of Object.keys(st.rows)) delete st.rows[k]
})

const refusedCases: Array<[string, string, string | null, RegExp]> = [
  ["Closed company with an old folder", "Closed", "F-old", /company is closed/],
  ["Cancelled company with an old folder", "Cancelled", "F-old", /company is closed/],
  ["Active company with no storage and no folder", "Active", null, /no document storage/],
]

describe("generateIntercompanyForAccount", () => {
  function seed(status: string, folder: string | null) {
    st.rows.accounts = { id: "acc-1", status, company_name: "Op LLC", state_of_formation: "WY", ein_number: "12-3456789", physical_address: "1 Main St, Cheyenne WY 82001", drive_folder_id: folder }
    st.rows.account_contacts = { contacts: { full_name: "Pat Manager" } }
    st.rows.members = [{ id: "m1", member_type: "company", full_name: null, company_name: "Treasury LLC", ownership_pct: 100, is_primary: true, ein: "98-7654321", address_street: "2 Main", address_city: "Miami", address_state: "FL", address_zip: "33101", address_country: "US" }]
  }
  it.each(refusedCases)("%s: error + alarm, nothing written in Drive", async (_n, status, folder, msg) => {
    seed(status, folder)
    const { generateIntercompanyForAccount } = await import("@/lib/operations/intercompany")
    const r = await generateIntercompanyForAccount("acc-1")
    expect(r.error).toMatch(msg)
    expect(r.success).toBeUndefined()
    expect(st.driveWrites).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(["drive_write_refused"])
  })
  it("company in storage: saved there, zero Drive calls", async () => {
    seed("Active", null); st.companyState = "store"
    const { generateIntercompanyForAccount } = await import("@/lib/operations/intercompany")
    const r = await generateIntercompanyForAccount("acc-1")
    expect(r.success).toBe(true)
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
  it("left-on-Drive company is frozen (Stop Drive S2): the plain sentence, nothing written in Drive, ONE alarm", async () => {
    seed("Offboarding", "F-rebis")
    const { generateIntercompanyForAccount } = await import("@/lib/operations/intercompany")
    const r = await generateIntercompanyForAccount("acc-1")
    expect(r.success).toBeUndefined()
    expect(r.error).toMatch(/read-only/)
    expect(st.driveWrites).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(["drive_write_refused"])
  })
})

describe("fileRenewal (Calendar 'Mark filed')", () => {
  function seed(status: string, folder: string | null) {
    st.rows.accounts = { id: "acc-1", status, company_name: "Op LLC", state_of_formation: "WY", drive_folder_id: folder, portal_tier: "active", notes: null, ra_renewal_date: "2026-11-01", annual_report_due_date: null }
  }
  const params = () => ({ account_id: "acc-1", delivery_id: null, kind: "ra" as const, filed_date: "2026-10-18", receipt: { file_name: "r.pdf", mime_type: "application/pdf", data: Buffer.from("%PDF") } })
  it.each(refusedCases)("%s: the filing fails with the plain sentence and nothing is written in Drive", async (_n, status, folder, msg) => {
    seed(status, folder)
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    const r = await fileRenewal(params())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(msg)
    expect(st.driveWrites).toEqual([])
    // (Calendar "Mark filed" is a staff action: the person who clicked is told by the error itself — #731's shared rule, no extra alarm)
  })
  it("company in storage: the receipt goes to storage, zero Drive calls", async () => {
    seed("Active", null); st.companyState = "store"
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    await fileRenewal(params())
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
  it("left-on-Drive company is frozen (Stop Drive S2): the filing fails with the plain sentence, nothing written in Drive", async () => {
    seed("Offboarding", "F-rebis")
    const { fileRenewal } = await import("@/lib/operations/file-renewal")
    const r = await fileRenewal(params())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/read-only/)
    expect(st.driveWrites).toEqual([])
  })
})
