/**
 * Stop Drive S2 review fixes (PR #747 QA):
 *  1 the staff emails of a signed request / Form 8832 for a company with no storage say plainly where the file really is (never "Drive folder")
 *  3 a company-category upload for a person of a FROZEN company who already has their own storage answers the frozen sentence
 *    (not "This company's files live in the CRM storage")
 * (2 — Calendar "Mark filed" answers 409 — is in stop-drive-ica-and-renewal.test.ts)
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  mails: [] as string[],
  companyState: "drive" as "store" | "drive" | "moving",
  noPdf: false,
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_legacy-drive-mocks")
  const sb = h.makeSupabase(st.rows, st.recorded as never)
  const orig = sb.storage.from
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sb.storage as any).from = (name?: string) => (st.noPdf ? { list: async () => ({ data: [], error: null }), download: async () => ({ data: null, error: null }), createSignedUrl: async () => ({ data: null }), remove: async () => ({ error: null }) } : orig(name))
  return { supabaseAdmin: sb }
})
vi.mock("@/lib/google-drive", async () => (await import("./_legacy-drive-mocks")).driveSpy([], [], { writesSucceed: true }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => st.companyState }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: async () => undefined }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class extends Error {},
  saveSignedPdfForAccount: vi.fn(async () => ({ route: "drive" })),
  saveDocumentForAccount: vi.fn(async () => ({ route: "drive" })),
  saveDocumentForContact: vi.fn(async () => ({ route: "drive" })),
}))
vi.mock("@/lib/gmail", () => ({ gmailPost: async (_p: string, body: { raw: string }) => { st.mails.push(Buffer.from(body.raw, "base64url").toString("utf8")); return {} } }))
vi.mock("@/lib/portal/chat-events", () => ({ emitLeaseSignedEvent: async () => ({}), emitSs4SignedEvent: async () => ({}) }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => null }))
vi.mock("@/lib/webhook-internal-auth", () => ({ verifyInternalWebhookSecret: () => true }))
vi.mock("@/lib/operations/document", () => ({ updateDocument: async () => ({}) }))
vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/crm-store/legacy-drive", async (orig) => {
  const real = await orig<typeof import("@/lib/crm-store/legacy-drive")>()
  return {
    ...real,
    // the person has their OWN storage; the company they belong to is frozen on its old Drive folder
    legacyDriveForContact: async () => ({ allowed: false, reason: "has_storage", sentence: real.LEGACY_REFUSAL_SENTENCE.has_storage }),
    legacyDriveForAccount: async () => ({ allowed: false, reason: "frozen", sentence: real.LEGACY_REFUSAL_SENTENCE.frozen }),
    raiseDriveWriteRefused: async () => "refused",
  }
})

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => {
  st.recorded.length = 0; st.mails.length = 0; st.noPdf = false; st.companyState = "drive"
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.rows.accounts = { status: "Offboarding", drive_folder_id: "F-rebis", company_name: "Acme LLC" }
})

describe("staff emails never claim a Drive folder", () => {
  it("signature-request-signed, company with no storage: says it is NOT filed and where the file is", async () => {
    st.rows.signature_requests = { id: "s1", token: "t", document_name: "Services Agreement", account_id: "acc-1", contact_id: "c1", signed_pdf_path: "s1/signed.pdf", service_delivery_id: null }
    st.rows.contacts = { full_name: "A B", email: "a@b.co" }
    const { POST } = await import("@/app/api/signature-request-signed/route")
    await POST(post("/api/signature-request-signed", { signature_request_id: "s1", token: "t" }))
    const mail = st.mails.join("\n")
    expect(mail).toContain("NOT filed")
    expect(mail).toContain("signing bucket")
    expect(mail).not.toMatch(/Drive folder/)
  })

  it("8832-signed, signed PDF not attached: says it is NOT filed and where the file is", async () => {
    st.rows.form_8832_applications = { id: "f1", token: "t", status: "signed", company_name: "Acme LLC", account_id: "acc-1", contact_id: "c1", entity_type: "SMLLC", owner_name: "A B", ein: "12-3456789" }
    st.noPdf = true // no signed PDF in the bucket → nothing to attach
    const { POST } = await import("@/app/api/8832-signed/route")
    await POST(post("/api/8832-signed", { form_id: "f1", token: "t" }))
    // the staff email's text part is base64
    const mail = st.mails.map((m) => Buffer.from(m.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8")).join("\n")
    expect(mail).toContain("NOT filed")
    expect(mail).toContain("signing bucket")
    expect(mail).not.toMatch(/Drive folder/)
  })
})

describe("admin upload-document: a company document for a person of a FROZEN company who has their own storage", () => {
  it("answers the frozen sentence, not 'files live in the CRM storage'", async () => {
    st.rows.contacts = { full_name: "A B" }
    st.rows.account_contacts = [{ account_id: "acc-1" }]
    const { POST } = await import("@/app/api/crm/admin-actions/upload-document/route")
    const { LEGACY_REFUSAL_SENTENCE } = await import("@/lib/crm-store/legacy-drive")
    const res = await POST(post("/api/crm/admin-actions/upload-document", { contact_id: "c1", storage_path: "p/x.pdf", file_name: "x.pdf", mime_type: "application/pdf", document_type: "Other", category: "Company" }) as never)
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(409)
    expect(body.detail).toBe(LEGACY_REFUSAL_SENTENCE.frozen)
    expect(body.detail).not.toMatch(/live in the CRM storage/)
  })
})
