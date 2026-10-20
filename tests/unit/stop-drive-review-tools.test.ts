/**
 * Stop Drive, slice S1c: the review of a closure form / a tax form files it FIRST.
 *  - closure (MCP tool AND the workflow twin) — one rule: marked reviewed only when filed; a Closed/Cancelled company with
 *    nothing to file is marked reviewed and says so; a missing upload file does not block the review once the summary is saved
 *    (ONE alarm); a form not linked to a company is not filed and not reviewed.
 *  - tax: the client's corrections are ALWAYS applied; a form that could not be filed is left UNREVIEWED and the reply says so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  companyState: "store" as "store" | "drive" | "moving",
  store: { summaryFileId: "store:s" as string | null, copied: [] as string[], failed: [] as string[], skipped: [] as string[], errors: [] as string[] },
  folderSaves: 0,
  storeSpecs: [] as Array<Record<string, unknown>>,
  alarms: [] as Array<Record<string, unknown>>,
  applied: [] as Array<{ id: string; leaveUnreviewed: boolean }>,
  alreadyApplied: false,
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({
  companyDocState: async () => state.companyState,
  liveOwnerOfAccount: async () => "owner-1",
  liveOwnerOfContact: async () => "person-owner",
}))
vi.mock("@/lib/crm-store/save-form", () => ({ saveFormToStore: vi.fn(async (spec: Record<string, unknown>) => { state.storeSpecs.push(spec); return state.store }) }))
vi.mock("@/lib/form-to-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/form-to-drive")>("@/lib/form-to-drive")
  return { ...actual, saveFormToDrive: vi.fn(async () => { state.folderSaves++; return { summaryFileId: "drive:s", copied: [], failed: [], skipped: [], errors: [] } }) }
})
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (e: Record<string, unknown>) => { state.alarms.push(e); return null } }))
vi.mock("@/lib/operations/tax-review", () => ({
  approveAndApplyTaxReview: vi.fn(async ({ submission_id, leaveUnreviewed }: { submission_id: string; leaveUnreviewed?: boolean }) => {
    state.applied.push({ id: submission_id, leaveUnreviewed: !!leaveUnreviewed })
    return { ok: true, job_id: "job-1", alreadyApplied: false, correctionsAlreadyApplied: state.alreadyApplied }
  }),
}))

import { NO_STORAGE_SENTENCE } from "@/lib/crm-store/no-storage"
import { ACCOUNT_REFUSED, ACCOUNT_OLD_FOLDER } from "./_stop-drive-mocks"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
function fakeServer() {
  const tools: Record<string, Handler> = {}
  return { server: { tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never, tools }
}

beforeEach(() => {
  state.companyState = "store"
  state.store = { summaryFileId: "store:s", copied: ["a.pdf"], failed: [], skipped: [], errors: [] }
  state.folderSaves = 0
  state.storeSpecs.length = 0
  state.alarms.length = 0
  state.applied.length = 0
  state.alreadyApplied = false
  state.recorded.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.closure_submissions = { id: "cs-1", token: "tok", status: "completed", account_id: "acct-1", contact_id: null, lead_id: null, reviewed_at: null, language: "en", submitted_data: { llc_name: "Acme" }, upload_paths: ["u/a.pdf"], changed_fields: null, completed_at: "2026-10-01" }
  state.rows.tax_return_submissions = { id: "ts-1", token: "tok", status: "completed", account_id: "acct-1", entity_type: "SMLLC", tax_year: 2025, language: "en", submitted_data: {}, upload_paths: [], changed_fields: null, completed_at: "2026-10-01", reviewed_at: null, confirmation_accepted: true }
  state.rows.accounts = { company_name: "Acme LLC", status: "Active", drive_folder_id: null, gdrive_folder_url: null }
})

const marked = () => state.recorded.some((r) => r.table === "closure_submissions" && r.op === "update")

describe("closure_form_review mark_reviewed (MCP)", () => {
  const run = async (args: Record<string, unknown> = { token: "tok", mark_reviewed: true }) => {
    const { registerClosureTools } = await import("@/lib/mcp/tools/closure")
    const f = fakeServer()
    registerClosureTools(f.server)
    return (await f.tools["closure_form_review"](args)).content[0].text
  }

  it("filed → marked reviewed", async () => {
    expect(await run()).toContain("Form marked as reviewed")
    expect(marked()).toBe(true)
  })
  it("company with nothing to receive it (active, no folder, no storage) → NOT reviewed, nothing changed", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED }
    const text = await run()
    expect(marked()).toBe(false)
    expect(text).toContain(NO_STORAGE_SENTENCE)
    expect(text).toContain("NOT marked as reviewed")
  })
  it("a Closed company with nothing to file → marked reviewed, and it says why", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", status: "Closed", drive_folder_id: null, gdrive_folder_url: null }
    const text = await run()
    expect(marked()).toBe(true)
    expect(text).toContain("company is closed, so there is nothing to file")
  })
  it("a company being moved → NOT reviewed", async () => {
    state.companyState = "moving"
    const text = await run()
    expect(marked()).toBe(false)
    expect(text).toContain("NOT marked as reviewed")
  })
  it("a missing upload file does not block: the summary is saved, ONE alarm, marked reviewed", async () => {
    state.store = { summaryFileId: "store:s", copied: [], failed: ["a.pdf (download failed after 3 attempts)", "b.pdf (download failed after 3 attempts)"], skipped: [], errors: [] }
    await run()
    expect(marked()).toBe(true)
    expect(state.alarms).toHaveLength(1)
    expect((state.alarms[0].context as { missing: string[] }).missing).toHaveLength(2)
  })
  it("the summary could not be saved → NOT reviewed (no alarm for uploads)", async () => {
    state.store = { summaryFileId: null, copied: [], failed: [], skipped: [], errors: ["Summary PDF error: x"] }
    await run()
    expect(marked()).toBe(false)
    expect(state.alarms).toEqual([])
  })
  it("a form with NO company but a PERSON (a contact-only closure): filed in the person's own storage, then marked reviewed", async () => {
    const sub = state.rows.closure_submissions as Record<string, unknown>
    sub.account_id = null
    sub.contact_id = "contact-1"
    state.rows.contacts = { full_name: "Mario Rossi" }
    const text = await run()
    expect(marked()).toBe(true)
    expect(text).toContain("Form marked as reviewed")
    expect(state.storeSpecs[0].target).toEqual({ kind: "contact", id: "contact-1", ownerId: "person-owner" })
  })
  it("a form with neither a company nor a person (a lead-only closure): never stuck — marked reviewed with a clear note that nothing was filed", async () => {
    const sub = state.rows.closure_submissions as Record<string, unknown>
    sub.account_id = null
    sub.contact_id = null
    sub.lead_id = "lead-1"
    state.rows.leads = { full_name: "Lead Person" }
    const text = await run()
    expect(marked()).toBe(true)
    expect(text).toContain("answers stay on the submission itself")
    expect(state.storeSpecs).toEqual([])
  })
  it("a person-only form whose storage save fails → NOT reviewed", async () => {
    const sub = state.rows.closure_submissions as Record<string, unknown>
    sub.account_id = null
    sub.contact_id = "contact-1"
    state.store = { summaryFileId: null, copied: [], failed: [], skipped: [], errors: ["Summary PDF error: x"] }
    await run()
    expect(marked()).toBe(false)
  })
  it("a company left on its old Drive folder is frozen (Stop Drive S2) → nothing filed anywhere, NOT marked reviewed", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_OLD_FOLDER }
    const text = await run()
    expect(state.folderSaves).toBe(0)
    expect(marked()).toBe(false)
    expect(text).toContain("NOT marked as reviewed")
  })
  it("without mark_reviewed nothing is filed or changed", async () => {
    state.companyState = "drive"
    await run({ token: "tok", mark_reviewed: false })
    expect(marked()).toBe(false)
    expect(state.folderSaves).toBe(0)
  })
})

describe("applyClosureReview (workflow twin) — same rule", () => {
  const run = async () => {
    const { approveAndApplyClosureReview: applyClosureReview } = await import("@/lib/operations/closure-review")
    return applyClosureReview({ submission_id: "cs-1", actor: "workflow:test" })
  }
  it("filed → reviewed", async () => {
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.recorded.some((x) => x.table === "closure_submissions" && x.op === "update")).toBe(true)
  })
  it("nothing can receive it → error, NOT marked reviewed (was: marked reviewed with 'skipped')", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED }
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain("NOT marked as reviewed")
    expect(state.recorded.filter((x) => x.table === "closure_submissions" && x.op === "update")).toEqual([])
  })
  it("a Closed company → reviewed", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", status: "Cancelled", drive_folder_id: null, gdrive_folder_url: null }
    expect((await run()).ok).toBe(true)
  })
})

describe("tax_form_review apply_changes", () => {
  const run = async () => {
    const { registerTaxTools } = await import("@/lib/mcp/tools/tax")
    const f = fakeServer()
    registerTaxTools(f.server)
    return (await f.tools["tax_form_review"]({ token: "tok", apply_changes: true })).content[0].text
  }

  it("filed → applied and marked reviewed (leaveUnreviewed false)", async () => {
    await run()
    expect(state.applied).toEqual([{ id: "ts-1", leaveUnreviewed: false }])
  })
  for (const mode of ["none", "moving", "errors"] as const) {
    it(`not filed (${mode}) → the client's corrections are STILL applied, but the form is left unreviewed and the reply says what was not filed`, async () => {
      if (mode === "none") { state.companyState = "drive"; state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED } }
      if (mode === "moving") state.companyState = "moving"
      if (mode === "errors") state.store = { summaryFileId: null, copied: [], failed: [], skipped: [], errors: ["Summary PDF error: x"] }
      const text = await run()
      expect(state.applied).toEqual([{ id: "ts-1", leaveUnreviewed: true }])
      expect(text).toContain("corrections are applied")
      expect(text).toContain("NOT filed anywhere")
      expect(text).toContain("NOT marked as reviewed")
    })
  }
  it("an already reviewed submission is not filed again", async () => {
    ;(state.rows.tax_return_submissions as Record<string, unknown>).reviewed_at = "2026-10-02"
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED }
    await run()
    expect(state.applied).toEqual([{ id: "ts-1", leaveUnreviewed: false }])
  })

  it("running the review a SECOND time (after the filing problem was fixed) only retries the filing: nothing is applied twice", async () => {
    // first run: nothing could receive the form → corrections applied, left unreviewed
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", ...ACCOUNT_REFUSED }
    await run()
    expect(state.applied).toEqual([{ id: "ts-1", leaveUnreviewed: true }])
    // the problem is fixed (the company now has storage); second run
    state.companyState = "store"
    state.applied.length = 0
    const text = await run()
    // the helper (mocked here) is called again, but WITHOUT the leave flag — it is the helper's own once-only rule (see
    // operations-tax-review.test.ts) that decides not to enqueue again; the reply must not claim it applied anything twice
    expect(state.applied).toEqual([{ id: "ts-1", leaveUnreviewed: false }])
    expect(text).not.toContain("NOT marked as reviewed")
  })
  it("a successful filing records the durable 'filed' marker on the submission", async () => {
    await run()
    const m = state.recorded.find((r) => r.table === "tax_return_submissions" && r.op === "update")?.payload as { drive_archive_meta: { filed_in: string } }
    expect(m.drive_archive_meta.filed_in).toBe("storage")
  })

  it("when the corrections were already applied by an earlier run, the reply says they were NOT applied again", async () => {
    state.alreadyApplied = true
    const text = await run()
    expect(text).toContain("NOT applied again")
    expect(text).not.toContain("Background job enqueued")
  })
})
