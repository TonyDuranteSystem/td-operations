/**
 * Approved tax questionnaire → one save per client submit (dev job 7df278cd, Shipment 2): the save job's rules.
 *   - the time printed on the PDF is pinned to the answers it was made for (a retry of the same answers makes the same file),
 *   - the "saved" marker is only set if the answers are still the ones that were saved (a resubmit during the save is never marked),
 *   - a closed company has nothing to file (marker set, said plainly, never an alarm),
 *   - the summary file carries its tax year,
 *   - a resubmit with CHANGED answers clears the marker in the same write and resets the tries; unchanged answers do not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { answersFingerprint } from "@/lib/tax/answers-fingerprint"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  saves: [] as Array<Record<string, unknown>>,
  merged: [] as Array<{ table: string; id: string; patch: Record<string, unknown> }>,
  route: "store" as "store" | "none",
  during: null as null | (() => void),
  result: { summaryFileId: "store:s" as string | null, copied: ["a.pdf"], failed: [] as string[], skipped: [] as string[], errors: [] as string[] },
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/archive/meta-merge", () => ({ mergeArchiveMeta: async (table: string, id: string, patch: Record<string, unknown>) => { state.merged.push({ table, id, patch }) } }))
vi.mock("@/lib/crm-store/save-account-form", () => ({
  saveFormForAccount: vi.fn(async (input: Record<string, unknown>) => {
    state.saves.push(input)
    state.during?.()
    return state.route === "none" ? { route: "none" } : { route: "store", result: state.result }
  }),
}))

const ANSWERS = { comp_foreign_accounts_over_10k: "No" }
const PATHS = ["tax/x/a.pdf"]
const FP = answersFingerprint(ANSWERS, PATHS)

beforeEach(() => {
  state.route = "store"
  state.during = null
  state.saves.length = 0
  state.merged.length = 0
  state.recorded.length = 0
  state.result = { summaryFileId: "store:s", copied: ["a.pdf"], failed: [], skipped: [], errors: [] }
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.tax_return_submissions = { id: "ts-1", account_id: "acct-1", token: "tok", tax_year: 2025, submitted_data: { ...ANSWERS }, upload_paths: [...PATHS], drive_archived_at: null, drive_archive_meta: null }
  state.rows.accounts = { company_name: "Acme LLC", drive_folder_id: null, status: "Active" }
})

const marker = () => state.recorded.find((r) => r.table === "tax_return_submissions" && r.op === "update" && (r.payload as Record<string, unknown>).drive_archived_at)
const submittedAtOf = (i: number) => (state.saves[i].meta as { submittedAt: string }).submittedAt

describe("the time on the saved PDF is pinned to the answers", () => {
  it("a first run stamps the time of the run and records it with the answers' fingerprint", async () => {
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await archiveTaxSubmission("ts-1")
    const ok = state.merged.find((m) => m.patch.filed_in === "storage")!
    expect(ok.patch.stamp).toEqual({ fp: FP, at: submittedAtOf(0) })
  })

  it("a retry of the SAME answers reuses the recorded time, so the PDF — and the saved version — stay the same", async () => {
    ;(state.rows.tax_return_submissions as Record<string, unknown>).drive_archive_meta = { attempts: 1, last_error: "x", stamp: { fp: FP, at: "2026-11-01T10:00:00.000Z" } }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await archiveTaxSubmission("ts-1")
    expect(submittedAtOf(0)).toBe("2026-11-01T10:00:00.000Z")
  })

  it("CHANGED answers get a new time (a new version), not the old one", async () => {
    ;(state.rows.tax_return_submissions as Record<string, unknown>).drive_archive_meta = { stamp: { fp: "some-older-answers", at: "2026-11-01T10:00:00.000Z" } }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await archiveTaxSubmission("ts-1")
    expect(submittedAtOf(0)).not.toBe("2026-11-01T10:00:00.000Z")
  })

  it("a failed try records the stamp too, so the retry finds it", async () => {
    state.result = { summaryFileId: "store:s", copied: [], failed: ["a.pdf (download failed after 3 attempts)"], skipped: [], errors: [] }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/not fully archived/)
    const attempt = state.merged.find((m) => m.patch.attempts === 1)!
    expect(attempt.patch.stamp).toEqual({ fp: FP, at: submittedAtOf(0) })
    expect(attempt.patch.failed).toEqual(["a.pdf (download failed after 3 attempts)"])
  })
})

describe("the saved marker is never set on answers that are no longer current", () => {
  it("the client resubmitted while the save ran: no marker, the attempt says so, and the job runs again", async () => {
    state.during = () => {
      ;(state.rows.tax_return_submissions as Record<string, unknown>).submitted_data = { comp_foreign_accounts_over_10k: "Yes" }
    }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/changed the answers/)
    expect(marker()).toBeUndefined()
    const attempt = state.merged.find((m) => m.patch.attempts === 1)!
    expect(String(attempt.patch.last_error)).toContain("changed the answers")
    expect(attempt.patch.stamp).toBeNull() // the next run pins a new time for the new answers
  })

  it("the client added a file while the save ran: same", async () => {
    state.during = () => {
      ;(state.rows.tax_return_submissions as Record<string, unknown>).upload_paths = [...PATHS, "tax/x/b.pdf"]
    }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/changed the answers/)
    expect(marker()).toBeUndefined()
  })

  it("nothing changed: the marker is set", async () => {
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    expect((await archiveTaxSubmission("ts-1")).status).toBe("archived")
    expect(marker()).toBeDefined()
  })
})

describe("a closed company", () => {
  it("has nothing to file: the marker is set, the record says so, and the job does not fail", async () => {
    state.route = "none"
    state.rows.accounts = { company_name: "Old LLC", drive_folder_id: null, status: "Closed" }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    const r = await archiveTaxSubmission("ts-1")
    expect(r.status).toBe("nothing_to_file")
    expect(marker()).toBeDefined()
    expect(state.merged.find((m) => m.patch.filed_in === "nothing")).toBeDefined()
  })

  it("an OPEN company that can receive nothing still fails loudly (no marker)", async () => {
    state.route = "none"
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/nowhere to archive/)
    expect(marker()).toBeUndefined()
  })
})

describe("the summary file carries its tax year", () => {
  const deps = (spec: { current: Record<string, unknown> | null }) => ({
    state: async () => "store" as const,
    liveOwner: async () => "owner-1",
    summary: async () => ({ bytes: Buffer.from("%PDF"), error: null, subfolder: "3. Tax", filePrefix: "Tax_Data", defaultBucket: "tax-form-uploads" }),
    store: (async (s: Record<string, unknown>) => { spec.current = s; return { summaryFileId: "store:s", copied: [], failed: [], skipped: [], errors: [] } }) as never,
  })
  const input = (formType: string, year?: unknown) => ({ accountId: "a1", formType, submittedData: {}, uploadPaths: [], meta: { token: "t", submittedAt: "x", companyName: "Acme", year: year as number | undefined } })

  it("a tax return's summary is tagged with the year", async () => {
    const real = await vi.importActual<typeof import("@/lib/crm-store/save-account-form")>("@/lib/crm-store/save-account-form")
    const spec = { current: null as Record<string, unknown> | null }
    await real.saveFormForAccount(input("tax_return", 2025), deps(spec))
    expect((spec.current!.summary as { periodYear: number }).periodYear).toBe(2025)
    await real.saveFormForAccount(input("tax_return", "2024"), deps(spec))
    expect((spec.current!.summary as { periodYear: number }).periodYear).toBe(2024)
  })

  it("no year, a bad year, or another form: no tag", async () => {
    const real = await vi.importActual<typeof import("@/lib/crm-store/save-account-form")>("@/lib/crm-store/save-account-form")
    const spec = { current: null as Record<string, unknown> | null }
    for (const [type, year] of [["tax_return", undefined], ["tax_return", "soon"], ["tax_return", 0], ["closure", 2025]] as const) {
      await real.saveFormForAccount(input(type, year), deps(spec))
      expect((spec.current!.summary as { periodYear: number | null }).periodYear).toBeNull()
    }
  })
})

describe("the client's resubmit (wizard-submit)", () => {
  const src = readFileSync("app/api/portal/wizard-submit/route.ts", "utf8")
  it("clears the saved marker in the SAME write — only when the answers or files changed", () => {
    expect(src).toContain("answersFingerprint(curSub.submitted_data, curSub.upload_paths) !== answersFingerprint(data, mergedUploadPaths)")
    expect(src).toContain("...(answersChanged ? { drive_archived_at: null } : {})")
    expect(src).toMatch(/\.select\('id, token, review_status, review_history, upload_paths, submitted_data'\)/)
  })
  it("resets the tries and the stuck-row alert for the new round", () => {
    expect(src).toContain("SAVE_RESET_META")
    expect(src).toMatch(/if \(answersChanged\) \{[\s\S]{0,400}mergeArchiveMeta\('tax_return_submissions', curSub\.id/)
  })
})
