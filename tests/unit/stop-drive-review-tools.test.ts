/**
 * Stop Drive, slice S1c fix round: closure_form_review / tax_form_review file the form FIRST and only then mark it reviewed
 * (tax: only then apply). A form that was not filed (nowhere to file it, company being moved, a failed save) leaves the
 * submission exactly as it was — no "reviewed", no apply job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  filing: "store" as "store" | "none" | "throw" | "moving" | "errors",
  applied: [] as string[],
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/crm-store/save-account-form", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crm-store/save-account-form")>("@/lib/crm-store/save-account-form")
  return {
    ...actual,
    saveFormForAccount: vi.fn(async () => {
      if (state.filing === "throw") throw new Error("storage down")
      if (state.filing === "moving") throw new Error("This company's files are being moved to the new storage right now — please try again in a few minutes.")
      if (state.filing === "none") return { route: "none" }
      const r = { summaryFileId: "store:s", copied: ["a.pdf"], failed: [] as string[], skipped: [] as string[], errors: state.filing === "errors" ? ["Summary PDF error: x"] : [] as string[] }
      return { route: "store", result: r }
    }),
  }
})
vi.mock("@/lib/operations/tax-review", () => ({
  approveAndApplyTaxReview: vi.fn(async ({ submission_id }: { submission_id: string }) => { state.applied.push(submission_id); return { ok: true, job_id: "job-1", alreadyApplied: false } }),
}))

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
function fakeServer() {
  const tools: Record<string, Handler> = {}
  return { server: { tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never, tools }
}

beforeEach(() => {
  state.filing = "store"
  state.applied.length = 0
  state.recorded.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.closure_submissions = { id: "cs-1", token: "tok", status: "completed", account_id: "acct-1", language: "en", submitted_data: { llc_name: "Acme" }, upload_paths: [], changed_fields: null, completed_at: "2026-10-01", client_name: "Acme" }
  state.rows.tax_return_submissions = { id: "ts-1", token: "tok", status: "completed", account_id: "acct-1", entity_type: "SMLLC", tax_year: 2025, language: "en", submitted_data: {}, upload_paths: [], changed_fields: null, completed_at: "2026-10-01", reviewed_at: null, confirmation_accepted: true }
  state.rows.accounts = { company_name: "Acme LLC" }
})

const marked = () => state.recorded.some((r) => r.table === "closure_submissions" && r.op === "update")

describe("closure_form_review mark_reviewed", () => {
  const run = async (args: Record<string, unknown> = { token: "tok", mark_reviewed: true }) => {
    const { registerClosureTools } = await import("@/lib/mcp/tools/closure")
    const f = fakeServer()
    registerClosureTools(f.server)
    return (await f.tools["closure_form_review"](args)).content[0].text
  }

  it("filed → marked reviewed", async () => {
    const text = await run()
    expect(marked()).toBe(true)
    expect(text).toContain("Form marked as reviewed")
  })
  for (const mode of ["none", "throw", "moving", "errors"] as const) {
    it(`not filed (${mode}) → NOT marked reviewed, nothing changed`, async () => {
      state.filing = mode
      const text = await run()
      expect(marked()).toBe(false)
      expect(text).toContain("NOT marked as reviewed")
      expect(text).not.toContain("Form marked as reviewed")
    })
  }
  it("without mark_reviewed nothing is filed or changed", async () => {
    state.filing = "none"
    await run({ token: "tok", mark_reviewed: false })
    expect(marked()).toBe(false)
  })
})

describe("tax_form_review apply_changes", () => {
  const run = async () => {
    const { registerTaxTools } = await import("@/lib/mcp/tools/tax")
    const f = fakeServer()
    registerTaxTools(f.server)
    return (await f.tools["tax_form_review"]({ token: "tok", apply_changes: true })).content[0].text
  }

  it("filed → applied", async () => {
    await run()
    expect(state.applied).toEqual(["ts-1"])
  })
  for (const mode of ["none", "throw", "moving", "errors"] as const) {
    it(`not filed (${mode}) → NOT applied (no job, not marked reviewed)`, async () => {
      state.filing = mode
      const text = await run()
      expect(state.applied).toEqual([])
      expect(text).toContain("NOT applied")
    })
  }
  it("an already reviewed submission is not filed again and goes straight to the helper's short-circuit", async () => {
    ;(state.rows.tax_return_submissions as Record<string, unknown>).reviewed_at = "2026-10-02"
    state.filing = "none"
    await run()
    expect(state.applied).toEqual(["ts-1"]) // the helper (mocked) decides; filing was not required again
  })
})
