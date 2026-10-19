/**
 * Stop Drive, slice S1c round 3: the archive JOBS file a company with no folder into its storage, and the marker they set
 * (drive_archived_at) is the durable "filed" fact that takes the row out of the sweep for good. A company that can receive
 * nothing fails the job loudly (attempts climb, the sweep's existing ONE alert fires) — never a silent skip, never an alarm that
 * fires forever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  route: "store" as "store" | "folder" | "none",
  saves: [] as Array<Record<string, unknown>>,
  merged: [] as Array<{ table: string; id: string; patch: Record<string, unknown> }>,
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
    return state.route === "none" ? { route: "none" } : { route: state.route, result: state.result }
  }),
}))
vi.mock("@/lib/form-to-drive", () => ({ saveFormToDrive: vi.fn(async () => { throw new Error("the old route must not be used when there is no folder") }) }))

beforeEach(() => {
  state.route = "store"
  state.saves.length = 0
  state.merged.length = 0
  state.recorded.length = 0
  state.result = { summaryFileId: "store:s", copied: ["a.pdf"], failed: [], skipped: [], errors: [] }
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.tax_return_submissions = { id: "ts-1", account_id: "acct-1", token: "tok", tax_year: 2025, submitted_data: {}, upload_paths: ["tax/x/a.pdf"], drive_archived_at: null, drive_archive_meta: null }
  state.rows.banking_submissions = { id: "bs-1", account_id: "acct-1", token: "tok", provider: "relay", status: "completed", submitted_data: {}, upload_paths: [], completed_at: "2026-10-01", created_at: "2026-10-01", drive_archived_at: null, drive_archive_meta: null }
  state.rows.accounts = { company_name: "Acme LLC", drive_folder_id: null }
})

const marker = (table: string) => state.recorded.find((r) => r.table === table && r.op === "update" && (r.payload as Record<string, unknown>).drive_archived_at)

describe("tax archive job", () => {
  it("a company with NO folder is filed in its storage; the marker is set and says where", async () => {
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    const r = await archiveTaxSubmission("ts-1")
    expect(r.status).toBe("archived")
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", formType: "tax_return", meta: expect.objectContaining({ year: 2025 }) })
    expect(typeof (state.saves[0].resolveBucket as (p: string) => string)).toBe("function")
    expect(marker("tax_return_submissions")).toBeDefined() // the durable "filed" marker
    // where it was filed is MERGED into the row's record (never a copy that could drop the sweep's alert flag)
    const m = state.merged.find((x) => x.table === "tax_return_submissions")!
    expect(m.patch.filed_in).toBe("storage")
    expect(m.patch.drive_folder_id).toBeNull()
  })

  it("a submission that already carries the marker is a no-op: it is never filed again", async () => {
    ;(state.rows.tax_return_submissions as Record<string, unknown>).drive_archived_at = "2026-10-02T00:00:00Z"
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    expect((await archiveTaxSubmission("ts-1")).status).toBe("already_archived")
    expect(state.saves).toEqual([])
  })

  it("a company that can receive nothing: the job FAILS loudly, the attempt is recorded, NO marker is set", async () => {
    state.route = "none"
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/nowhere to archive/)
    expect(marker("tax_return_submissions")).toBeUndefined()
    const attempt = state.merged.find((x) => x.table === "tax_return_submissions")!
    expect(attempt.patch.attempts).toBe(1)
    expect(String(attempt.patch.last_error)).toContain("no storage and no folder")
  })

  it("a partial filing (a file failed) sets no marker and is retried", async () => {
    state.result = { summaryFileId: "store:s", copied: [], failed: ["a.pdf (download failed)"], skipped: [], errors: [] }
    const { archiveTaxSubmission } = await import("@/lib/tax/archive-submission")
    await expect(archiveTaxSubmission("ts-1")).rejects.toThrow(/not fully archived/)
    expect(marker("tax_return_submissions")).toBeUndefined()
  })
})

describe("generic form archive job (banking)", () => {
  it("a company with NO folder is filed by company; the marker records where", async () => {
    const { archiveFormSubmission } = await import("@/lib/forms/archive-submission")
    const r = await archiveFormSubmission("banking", "bs-1")
    expect(r.status).toBe("archived")
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", formType: "banking_relay" })
    expect(marker("banking_submissions")).toBeDefined()
    expect(state.merged.find((x) => x.table === "banking_submissions")!.patch.filed_in).toBe("storage")
  })

  it("a company that can receive nothing: fails loudly, no marker", async () => {
    state.route = "none"
    const { archiveFormSubmission } = await import("@/lib/forms/archive-submission")
    await expect(archiveFormSubmission("banking", "bs-1")).rejects.toThrow(/nowhere to archive/)
    expect(marker("banking_submissions")).toBeUndefined()
  })

  it("a company WITH a folder keeps the old route (saveFormToDrive)", async () => {
    state.rows.accounts = { company_name: "Acme LLC", drive_folder_id: "FOLDER1" }
    const { archiveFormSubmission } = await import("@/lib/forms/archive-submission")
    await expect(archiveFormSubmission("banking", "bs-1")).rejects.toThrow(/old route must not be used/) // proves it was called
    expect(state.saves).toEqual([])
  })
})
