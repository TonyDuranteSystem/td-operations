/**
 * Stop Drive, slice S1c (dev job 264bb882): /api/ss4-signed no longer needs a Drive folder and no longer skips quietly.
 *
 * - A company with storage: the signed SS-4 and the IRS package (SS-4 + Articles) are saved in its storage, internal; zero Drive calls.
 * - A company with no storage: nothing is written to Drive; the result carries an ERROR step with the one plain sentence for the
 *   signed copy AND for the IRS package (it used to say "built, not uploaded" with status ok); the notification email still goes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { PDFDocument } from "pdf-lib"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveCalls: [] as string[],
  companyState: "store" as "store" | "drive",
  saves: [] as Array<Record<string, unknown>>,
  mails: [] as string[],
  pdf: new Uint8Array(),
  driveMode: "forbid" as "forbid" | "record",
  listEmpty: false,
  moving: false,
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  const base = h.makeSupabase(state.rows, state.recorded as never)
  // the signed-ss4 bucket returns a real one-page PDF
  const bucket = () => ({
    list: async () => ({ data: state.listEmpty ? [] : [{ name: "signed.pdf" }], error: null }),
    download: async () => ({ data: { arrayBuffer: async () => state.pdf.buffer.slice(state.pdf.byteOffset, state.pdf.byteOffset + state.pdf.byteLength), type: "application/pdf" }, error: null }),
    createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/u" } }),
  })
  return { supabaseAdmin: { from: base.from, storage: { from: bucket } } }
})
vi.mock("@/lib/google-drive", async () => (await import("./_stop-drive-mocks")).driveSpyDynamic(state.driveCalls, () => state.driveMode))
vi.mock("@/lib/portal/auto-save-document", () => ({ autoSaveDocument: async () => ({ id: "doc-drive-1" }) }))
vi.mock("@/lib/portal/chat-events", () => ({ emitSs4SignedEvent: async () => ({ emitted: true }) }))
vi.mock("@/lib/gmail", () => ({ gmailPost: async (_p: string, body: { raw: string }) => { state.mails.push(Buffer.from(body.raw, "base64url").toString()); return {} } }))
vi.mock("@/lib/ss4/resolve-articles-pdf", () => ({ resolveArticlesForSs4: async () => Buffer.from(state.pdf) }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => null }))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => state.companyState }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class CompanyMovingError extends Error { constructor() { super("This company's files are being moved to the new storage right now — please try again in a few minutes."); this.name = "CompanyMovingError" } },
  saveSignedPdfForAccount: vi.fn(async (input: Record<string, unknown>) => {
    if (state.moving) { const { CompanyMovingError } = await import("@/lib/crm-store/save-for-account"); throw new CompanyMovingError() }
    state.saves.push(input)
    return { route: "store", fileId: `f-${state.saves.length}`, pointer: `store:f-${state.saves.length}`, documentRowId: "doc-1", status: "created" }
  }),
}))

import { NO_STORAGE_SENTENCE } from "@/lib/crm-store/no-storage"
import { ACCOUNT_OLD_FOLDER, ACCOUNT_CLOSED_WITH_FOLDER, setDriveMocked } from "./_stop-drive-mocks"

type Step = { step: string; status: string; detail?: string }
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
/** The public response hides error detail ("Not completed — staff have been notified."); the full detail is logged for staff. */
async function stepsOf(res: Response): Promise<{ steps: Step[]; publicSteps: Step[] }> {
  const publicSteps = (await res.json()).results as Step[]
  const logged = errorSpy.mock.calls.find((c) => String(c[0]).includes("[ss4-signed] steps with errors"))
  const full = logged ? (JSON.parse(String(c1(logged))) as Step[]) : []
  const steps = publicSteps.map((p) => full.find((f) => f.step === p.step) ?? p)
  return { steps, publicSteps }
}
const c1 = (c: unknown[]) => c[1]

const req = () => new NextRequest("http://localhost/api/ss4-signed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ss4_id: "ss4-1", token: "tok" }) })

beforeEach(async () => {
  errorSpy.mockClear()
  const d = await PDFDocument.create()
  d.addPage()
  state.pdf = new Uint8Array(await d.save())
  state.companyState = "store"
  state.driveMode = "forbid"
  state.listEmpty = false
  state.moving = false
  setDriveMocked(false)
  state.recorded.length = 0
  state.driveCalls.length = 0
  state.saves.length = 0
  state.mails.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.ss4_applications = { id: "ss4-1", token: "tok", access_code: "123", company_name: "Acme LLC", account_id: "acct-1", contact_id: "c-1", entity_type: "SMLLC", responsible_party_name: "A B", status: "signed", state_of_formation: "WY" }
  state.rows.accounts = { status: "Active", drive_folder_id: null, gdrive_folder_url: null }
})

describe("/api/ss4-signed", () => {
  it("storage company: signed SS-4 + IRS package saved in the storage (internal), zero Drive calls", async () => {
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(state.saves).toHaveLength(2)
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", portalVisible: false, documentType: "form_ss_4", callerKey: "ss4-signed-company:ss4-1" })
    expect(state.saves[1]).toMatchObject({ accountId: "acct-1", portalVisible: false, documentType: "irs_fax", callerKey: "ss4-irs-package:ss4-1" })
    const steps = body.results as Array<{ step: string; status: string }>
    expect(steps.find((s) => s.step === "drive_upload")?.status).toBe("ok")
    expect(steps.find((s) => s.step === "irs_package")?.status).toBe("ok")
    expect(steps.find((s) => s.step === "signed_doc")).toBeUndefined()
    expect(state.driveCalls).toEqual([])
  })

  it("no-storage company: nothing saved or written to Drive, and neither the signed copy nor the IRS package is reported as filed", async () => {
    state.companyState = "drive"
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps, publicSteps } = await stepsOf(res)
    expect(state.saves).toEqual([])
    expect(state.driveCalls).toEqual([])
    expect(steps.find((s) => s.step === "signed_doc")).toMatchObject({ status: "error", detail: NO_STORAGE_SENTENCE })
    // the public response never carries the internal detail
    expect(publicSteps.filter((p) => p.status === "error").every((p) => p.detail === "Not completed — staff have been notified.")).toBe(true)
    const irs = steps.find((s) => s.step === "irs_package")!
    expect(irs.status).toBe("error")
    expect(irs.detail).toContain(NO_STORAGE_SENTENCE)
    // staff still get the notification email, with the package attached
    expect(state.mails).toHaveLength(1)
    expect(state.mails[0]).toContain("application/pdf")
  })

  it("a company left on its old folder: the signed copy and the IRS package go to its folder as before, registered as internal documents", async () => {
    state.companyState = "drive"
    state.driveMode = "record"
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    expect(state.saves).toEqual([])
    expect(state.driveCalls.filter((c) => c === "uploadBinaryToDriveUpsert")).toHaveLength(2)
    expect(steps.find((s) => s.step === "drive_upload")?.status).toBe("ok")
    expect(steps.find((s) => s.step === "irs_package")?.status).toBe("ok")
    expect(steps.find((s) => s.step === "signed_doc")).toBeUndefined()
  })

  it("a webhook RETRY whose fallback row already exists is not reported as 'no storage' (the signed copy IS filed) — sandbox fallback", async () => {
    setDriveMocked(true) // the holding-area row exists only where Drive is faked (the sandbox)
    state.companyState = "drive"
    state.rows.service_deliveries = { id: "sd-1", stage: "SS-4 Signed", stage_history: [] }
    state.rows.documents = { id: "existing-row" }
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    expect(steps.find((s) => s.step === "signed_doc_storage")?.detail).toBe("Signed doc already linked")
    expect(steps.find((s) => s.step === "signed_doc")).toBeUndefined()
  })

  it("a company that HAS storage but whose signed copy was not saved gets an accurate message, never the 'no storage' sentence", async () => {
    state.listEmpty = true
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    const sd = steps.find((s) => s.step === "signed_doc")
    expect(sd?.status).toBe("error")
    expect(sd?.detail).not.toBe(NO_STORAGE_SENTENCE)
    expect(sd?.detail).toContain("could not be filed in the company's storage")
  })

  it("the fax task points to the notification email (always true) — no Drive wording, no claim about where it is filed", async () => {
    const { POST } = await import("@/app/api/ss4-signed/route")
    await POST(req())
    const task = state.recorded.find((r) => r.table === "tasks" && r.op === "insert")?.payload as { description: string }
    expect(task.description).toContain("Fax the signed SS-4 (with the Articles) to the IRS at (855) 641-6935")
    expect(task.description).toContain("SS-4 Signed — Ready to Fax")
    expect(task.description).not.toContain("attached")
    expect(task.description.toLowerCase()).not.toContain("drive")
  })

  // the body part of the email is base64: decode it
  const stateMail = () => {
    const raw = state.mails[0] ?? ""
    const m = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/.exec(raw)
    return m ? Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8") : raw
  }
  it("a CLOSED company (no storage place): no holding-area pointer is recorded, the email says plainly what was NOT filed", async () => {
    state.companyState = "drive"
    state.rows.accounts = ACCOUNT_CLOSED_WITH_FOLDER
    state.rows.service_deliveries = { id: "sd-1", stage: "SS-4 Signed", stage_history: [] }
    state.rows.documents = null
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    expect(state.recorded.filter((r) => r.table === "documents" && r.op === "insert")).toEqual([]) // no holding-area row
    expect(steps.find((x) => x.step === "signed_doc_storage")).toBeUndefined()
    expect(steps.find((x) => x.step === "signed_doc")?.status).toBe("error")
    expect(stateMail()).toContain("NOT FILED")
    expect(stateMail()).toContain("could not be filed in the company's documents")
    expect(state.driveCalls.filter((c) => c.startsWith("upload"))).toEqual([])
  })

  it("a company being MOVED: nothing recorded as filed, no holding-area row, the email says what was not filed", async () => {
    state.moving = true
    state.rows.service_deliveries = { id: "sd-1", stage: "SS-4 Signed", stage_history: [] }
    state.rows.documents = null
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    expect(state.recorded.filter((r) => r.table === "documents" && r.op === "insert")).toEqual([])
    expect(steps.find((x) => x.step === "signed_doc")?.status).toBe("error")
    expect(stateMail()).toContain("NOT FILED")
  })

  it("a company that IS filed gets no 'NOT FILED' line in the email", async () => {
    const { POST } = await import("@/app/api/ss4-signed/route")
    await POST(req())
    expect(stateMail()).not.toContain("NOT FILED")
  })

  it("sandbox only (Drive faked): the holding-area row still exists there, so the workspace works end to end", async () => {
    setDriveMocked(true)
    state.companyState = "drive"
    state.rows.service_deliveries = { id: "sd-1", stage: "SS-4 Signed", stage_history: [] }
    state.rows.documents = null
    const { POST } = await import("@/app/api/ss4-signed/route")
    await POST(req())
    expect(state.recorded.some((r) => r.table === "documents" && r.op === "insert")).toBe(true)
  })

  it("a company left on its old folder whose upload FAILED is told what is true — never 'no storage'", async () => {
    state.companyState = "drive"
    state.driveMode = "forbid" // every Drive call throws
    state.rows.accounts = ACCOUNT_OLD_FOLDER
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(req())
    const { steps } = await stepsOf(res)
    const sd = steps.find((s) => s.step === "signed_doc")
    expect(sd?.status).toBe("error")
    expect(sd?.detail).toBe("The signed SS-4 could not be uploaded to the company's folder — see the earlier steps.")
    expect(sd?.detail).not.toContain("no document storage")
  })
})
