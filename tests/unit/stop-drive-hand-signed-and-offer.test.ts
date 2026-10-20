/**
 * Stop Drive S1d (dev job 264bb882): the hand-signed Operating Agreement filing and the signed-offer contract filing.
 * Storage company = storage, zero Drive calls. Closed / Cancelled / no folder = nothing written in Drive + an alarm.
 * Left-on-Drive company (Offboarding, folder, no storage) = FROZEN since Stop Drive S2 (alarm, nothing written).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveWrites: [] as string[],
  driveReads: [] as string[],
  companyState: "drive" as "store" | "drive" | "moving",
  saves: [] as Array<Record<string, unknown>>,
  alarms: [] as Array<{ kind: string; details: Record<string, unknown> }>,
}))

vi.mock("@/lib/supabase-admin", async () => ({ supabaseAdmin: (await import("./_legacy-drive-mocks")).makeSupabase(st.rows, st.recorded as never) }))
vi.mock("@/lib/google-drive", async () => (await import("./_legacy-drive-mocks")).driveSpy(st.driveWrites, st.driveReads, { writesSucceed: true }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => st.companyState }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: async (kind: string, details: Record<string, unknown>) => { st.alarms.push({ kind, details }) } }))
const stored = () => ({ route: "store", fileId: "f1", pointer: "store:f1", documentRowId: "doc-1", status: "created" })
vi.mock("@/lib/crm-store/save-for-account", () => ({
  saveSignedPdfForAccount: async (i: Record<string, unknown>) => { if (st.companyState === "store") { st.saves.push(i); return stored() } return { route: "drive" } },
  saveDocumentForAccount: async (i: Record<string, unknown>) => { if (st.companyState === "store") { st.saves.push(i); return stored() } return { route: "drive" } },
  saveDocumentForContact: async () => ({ route: "drive" }),
}))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async () => ({ id: "d" }) }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => null }))
vi.mock("@/lib/gmail", () => ({ gmailPost: async () => ({}) }))
vi.mock("@/lib/portal/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), getRateLimitKey: () => "k" }))
vi.mock("@/lib/auth/staff-preview", () => ({ isStaffPreview: async () => false }))
vi.mock("@/lib/esign/access-guard", () => ({ accessCodeError: () => null }))
vi.mock("@/lib/pdf/operating-agreement-pdf", () => ({ generateOperatingAgreementPDF: async () => new Uint8Array([37, 80, 68, 70]) }))

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  st.recorded.length = 0; st.driveWrites.length = 0; st.driveReads.length = 0; st.saves.length = 0; st.alarms.length = 0
  st.companyState = "drive"
  for (const k of Object.keys(st.rows)) delete st.rows[k]
})

const acct = (status: string, folder: string | null) => { st.rows.accounts = { status, drive_folder_id: folder, company_name: "Acme LLC" } }
const cases: Array<[string, () => void, "store" | "refused"]> = [
  ["company in storage", () => { st.companyState = "store"; acct("Active", null) }, "store"],
  ["Closed company with an old folder", () => acct("Closed", "F-old"), "refused"],
  ["Active company, no storage, no folder", () => acct("Active", null), "refused"],
  ["left-on-Drive company (Offboarding, folder) is frozen", () => acct("Offboarding", "F-rebis"), "refused"],
]

describe("/api/operating-agreement/[token]/hand-signed", () => {
  it.each(cases)("%s", async (_n, setup, expected) => {
    st.rows.oa_agreements = {
      id: "o1", token: "tok", access_code: "c", status: "sent", company_name: "Acme LLC", account_id: "acc-1", contact_id: "c1", entity_type: "SMLLC",
      member_name: "A B", total_signers: 1, state_of_formation: "WY", effective_date: "2026-01-01", members: [], duration: "perpetual", principal_address: "1 Main",
    }
    st.rows.oa_signatures = []
    setup()
    const fd = new FormData(); fd.set("code", "c")
    const req = new NextRequest("http://localhost/api/operating-agreement/tok/hand-signed", { method: "POST", body: fd })
    const { POST } = await import("@/app/api/operating-agreement/[token]/hand-signed/route")
    await POST(req, { params: Promise.resolve({ token: "tok" }) })
    if (expected === "store") { expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([]) }
    else { expect(st.driveWrites).toEqual([]); expect(st.alarms.map((a) => a.kind)).toEqual(["drive_write_refused"]) }
  })
})
