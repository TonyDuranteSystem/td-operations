/**
 * Stop Drive S1d (dev job 264bb882): the signing routes' Drive branch.
 *  - company in storage       -> saved in storage, ZERO Drive calls
 *  - Closed / Cancelled       -> nothing written in Drive, an ERROR step + a staff alarm
 *  - no storage and no folder -> nothing written, an ERROR step + a staff alarm (it used to say "skipped")
 *  - left-on-Drive company (folder, no storage, Offboarding) -> still filed in Drive, exactly as before
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
  autoSaved: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_legacy-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(st.rows, st.recorded as never) }
})
vi.mock("@/lib/google-drive", async () => (await import("./_legacy-drive-mocks")).driveSpy(st.driveWrites, st.driveReads, { writesSucceed: true }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => st.companyState }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: async (kind: string, details: Record<string, unknown>) => { st.alarms.push({ kind, details }) } }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  saveSignedPdfForAccount: vi.fn(async (input: Record<string, unknown>) => {
    if (st.companyState === "store") { st.saves.push(input); return { route: "store", fileId: "f1", pointer: "store:f1", documentRowId: "doc-1", status: "created" } }
    return { route: "drive" }
  }),
}))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async (p: Record<string, unknown>) => { st.autoSaved.push(p); return { id: "d" } } }))
vi.mock("@/lib/portal/chat-events", () => ({ emitLeaseSignedEvent: async () => ({}), emitSs4SignedEvent: async () => ({}) }))
vi.mock("@/lib/gmail", () => ({ gmailPost: async () => ({}) }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => null }))
vi.mock("@/lib/webhook-internal-auth", () => ({ verifyInternalWebhookSecret: () => true }))
vi.mock("@/lib/operations/document", () => ({ updateDocument: async () => ({}) }))

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

function account(status: string, folder: string | null) { st.rows.accounts = { status, drive_folder_id: folder, company_name: "Acme LLC" } }

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  st.recorded.length = 0; st.driveWrites.length = 0; st.driveReads.length = 0; st.saves.length = 0; st.alarms.length = 0; st.autoSaved.length = 0
  st.companyState = "drive"
  for (const k of Object.keys(st.rows)) delete st.rows[k]
})

const cases: Array<[string, () => void, "store" | "refused-closed" | "refused-nofolder" | "legacy"]> = [
  ["company in storage", () => { st.companyState = "store"; account("Active", null) }, "store"],
  ["Closed company with an old folder", () => account("Closed", "F-old"), "refused-closed"],
  ["Cancelled company with an old folder", () => account("Cancelled", "F-old"), "refused-closed"],
  ["Active company with no storage and no folder", () => account("Active", null), "refused-nofolder"],
  ["left-on-Drive company (Offboarding, folder, no storage)", () => account("Offboarding", "F-rebis"), "legacy"],
]

function check(kind: string, stepName: (b: any) => { status: string; detail?: string } | undefined, run: () => Promise<any>, setupRows: () => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  describe(kind, () => {
    it.each(cases)("%s", async (_n, setup, expected) => {
      setupRows(); setup()
      const body = await run()
      const step = stepName(body)
      if (expected === "store") {
        expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
        expect(step?.status).toBe("ok"); expect(st.saves).toHaveLength(1)
      } else if (expected === "legacy") {
        expect(st.driveWrites.length).toBeGreaterThan(0)
        expect(st.driveWrites.join(" ")).toContain("F-rebis")
        expect(st.alarms).toEqual([])
      } else {
        expect(st.driveWrites).toEqual([])
        expect(step?.status).toBe("error")
        expect(step?.detail).toMatch(expected === "refused-closed" ? /company is closed/ : /no document storage/)
        expect(st.alarms.map((a) => a.kind)).toEqual(["drive_write_refused"])
        expect(st.autoSaved).toEqual([])
      }
    })
  })
}

check("/api/lease-signed", (b) => b.results.find((r: { step: string }) => r.step === "drive_upload"), async () => {
  const { POST } = await import("@/app/api/lease-signed/route")
  return (await POST(post("/api/lease-signed", { lease_id: "l1", token: "t", code: "c" }))).json()
}, () => {
  st.rows.lease_agreements = { id: "l1", token: "t", access_code: "c", status: "signed", tenant_company: "Acme LLC", suite_number: "100", account_id: "acc-1", contact_id: "c1", pdf_storage_path: "t/lease-signed.pdf" }
})

check("/api/8832-signed", (b) => b.results.find((r: { step: string }) => r.step === "drive_upload"), async () => {
  const { POST } = await import("@/app/api/8832-signed/route")
  return (await POST(post("/api/8832-signed", { form_id: "f1", token: "t" }))).json()
}, () => {
  st.rows.form_8832_applications = { id: "f1", token: "t", status: "signed", company_name: "Acme LLC", account_id: "acc-1", contact_id: "c1", entity_type: "SMLLC", owner_name: "A B", ein: "12-3456789" }
})

check("/api/oa-signed", (b) => b.results.find((r: { step: string }) => r.step === "drive_upload"), async () => {
  const { POST } = await import("@/app/api/oa-signed/route")
  return (await POST(post("/api/oa-signed", { oa_id: "o1", token: "acme-oa-2026" }))).json()
}, () => {
  st.rows.oa_agreements = { id: "o1", token: "acme-oa-2026", access_code: "c", pdf_storage_path: "acme-oa-2026/oa-signed-1.pdf", company_name: "Acme LLC", account_id: "acc-1", contact_id: "c1", entity_type: "SMLLC", manager_name: null, status: "signed", total_signers: 1, signed_count: 1 }
})

describe("/api/signature-request-signed", () => {
  beforeEach(() => {
    st.rows.signature_requests = { id: "s1", token: "t", document_name: "Services Agreement", account_id: "acc-1", contact_id: "c1", signed_pdf_path: "s1/signed.pdf", service_delivery_id: null }
    st.rows.contacts = { full_name: "A B", email: "a@b.co" }
  })
  it.each(cases)("%s", async (_n, setup, expected) => {
    setup()
    const { POST } = await import("@/app/api/signature-request-signed/route")
    const body = await (await POST(post("/api/signature-request-signed", { signature_request_id: "s1", token: "t" }))).json()
    const lines = (body.results ?? []) as string[]
    if (expected === "store") {
      expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
    } else if (expected === "legacy") {
      expect(st.driveWrites.join(" ")).toContain("F-rebis")
      expect(st.alarms).toEqual([])
    } else {
      expect(st.driveWrites).toEqual([])
      expect(lines.some((l) => l.startsWith("drive_upload: error"))).toBe(true)
      expect(st.alarms.map((a) => a.kind)).toEqual(["drive_write_refused"])
      expect(st.autoSaved).toEqual([])
    }
  })
})

describe('/api/signature-request-signed — person-level agreements and lookup failures', () => {
  beforeEach(() => {
    st.rows.signature_requests = { id: "s1", token: "t", document_name: "Personal Agreement", account_id: null, contact_id: "c1", signed_pdf_path: "s1/signed.pdf", service_delivery_id: null }
    st.rows.contacts = { full_name: "A B", email: "a@b.co" }
  })
  it("no company: no alarm, no Drive call, the later steps still run (the response is a normal success)", async () => {
    const { POST } = await import("@/app/api/signature-request-signed/route")
    const res = await POST(post("/api/signature-request-signed", { signature_request_id: "s1", token: "t" }))
    expect(res.status).toBe(200)
    expect(st.alarms).toEqual([])
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
})
