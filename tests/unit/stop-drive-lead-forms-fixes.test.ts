import { describe, it, expect, vi, beforeEach } from "vitest"

/** Stop-Drive S1a fix round (2026-10-18): exact contact match, honest filing result + alarm, attempts counted when the destination cannot be resolved. */

let rows: Array<{ id: string; email: string | null }> = []
const patterns: string[] = []
const updates: Array<Record<string, unknown>> = []
vi.mock("@/lib/supabase-admin", () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.ilike = (_c: string, pattern: string) => { patterns.push(pattern); return chain }
  chain.limit = async () => ({ data: rows, error: null })
  chain.eq = () => chain
  chain.maybeSingle = async () => ({
    data: { id: "sub-1", token: "t", status: "completed", account_id: null, contact_id: null, lead_id: null, submitted_data: { llc_name: "X" }, drive_archived_at: null, drive_archive_meta: {} },
    error: null,
  })
  chain.update = (u: Record<string, unknown>) => { updates.push(u); return chain }
  return { supabaseAdmin: { from: () => chain } }
})

const alarms: Array<[string, Record<string, unknown>]> = []
vi.mock("@/lib/crm-store/formation-pilot", () => ({
  raisePilotAlarm: vi.fn(async (kind: string, details: Record<string, unknown>) => { alarms.push([kind, details]) }),
}))

const saveMock = vi.fn()
vi.mock("@/lib/form-to-drive", () => ({ saveFormToDrive: (...a: unknown[]) => saveMock(...a) }))

let destination: unknown = { marker: "person-storage:11111111-1111-4111-8111-111111111111" }
vi.mock("@/lib/crm-store/lead-form-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crm-store/lead-form-store")>("@/lib/crm-store/lead-form-store")
  return { ...actual, storageDestinationForForm: vi.fn(async () => destination) }
})

import { findContactByExactEmail, escapeLikeExact } from "@/lib/crm-store/lead-form-store"
import { fileFormPackage, type FileFormPackageInput } from "@/lib/forms/file-form-package"

beforeEach(() => { rows = []; patterns.length = 0; updates.length = 0; alarms.length = 0; saveMock.mockReset(); destination = { marker: "person-storage:11111111-1111-4111-8111-111111111111" } })

describe("findContactByExactEmail — the wrong-person bug (zz_qa2sd@… matched zzxqa2sd@…)", () => {
  it("escapes the wildcard characters so '_' and '%' are plain letters", () => {
    expect(escapeLikeExact("zz_qa2sd@x.test")).toBe("zz\\_qa2sd@x.test")
    expect(escapeLikeExact("a%b\\c")).toBe("a\\%b\\\\c")
  })
  it("sends the escaped pattern to the database", async () => {
    await findContactByExactEmail("ZZ_QA2SD@x.test ")
    expect(patterns).toEqual(["zz\\_qa2sd@x.test"])
  })
  it("never takes a look-alike row the database returned (defence in depth)", async () => {
    rows = [{ id: "other", email: "zzxqa2sd@x.test" }]
    expect(await findContactByExactEmail("zz_qa2sd@x.test")).toEqual({ status: "none" })
  })
  it("matches case-insensitively and ignores surrounding spaces", async () => {
    rows = [{ id: "c1", email: " Mario.Rossi@Example.com" }]
    expect(await findContactByExactEmail("mario.rossi@example.COM")).toEqual({ status: "one", id: "c1" })
  })
  it("two contacts with the same email = many (nobody is picked)", async () => {
    rows = [{ id: "c1", email: "a@x.test" }, { id: "c2", email: "A@X.test" }]
    expect(await findContactByExactEmail("a@x.test")).toEqual({ status: "many", ids: ["c1", "c2"] })
  })
  it("an empty email matches nobody and does not even ask the database", async () => {
    expect(await findContactByExactEmail("  ")).toEqual({ status: "none" })
    expect(await findContactByExactEmail(null)).toEqual({ status: "none" })
    expect(patterns).toEqual([])
  })
})

const base = (over: Partial<FileFormPackageInput> = {}): FileFormPackageInput => ({
  route: "formation-form-completed", formType: "formation", submittedData: {}, uploadPaths: ["a/b.pdf"],
  meta: { token: "tok", submittedAt: "2026-10-18T00:00:00Z" }, contactId: "11111111-1111-4111-8111-111111111111", ...over,
})

describe("fileFormPackage — a failed filing is never reported as ok", () => {
  it("ok only when the summary saved and nothing failed; no alarm", async () => {
    saveMock.mockResolvedValue({ summaryFileId: "store:x", copied: ["b.pdf"], failed: [], skipped: [], errors: [] })
    const r = await fileFormPackage(base())
    expect(r).toMatchObject({ step: "storage_save", status: "ok" })
    expect(r.detail).toContain("1 file(s) filed")
    expect(alarms).toEqual([])
  })
  it("a file in `failed` (while errors is empty) turns the step into an error and raises the alarm", async () => {
    saveMock.mockResolvedValue({ summaryFileId: "store:x", copied: [], failed: ["b.pdf"], skipped: [], errors: [] })
    const r = await fileFormPackage(base())
    expect(r.status).toBe("error")
    expect(r.detail).toContain("1 file(s) failed")
    expect(alarms.map((a) => a[0])).toEqual(["lead_form_filing_failed"])
    expect(alarms[0][1]).toMatchObject({ route: "formation-form-completed", formType: "formation", token: "tok" })
  })
  it("a missing summary PDF is an error too", async () => {
    saveMock.mockResolvedValue({ summaryFileId: null, copied: [], failed: [], skipped: [], errors: [] })
    expect((await fileFormPackage(base())).status).toBe("error")
    expect(alarms).toHaveLength(1)
  })
  it("a thrown error is an error step + alarm, not an exception", async () => {
    saveMock.mockRejectedValue(new Error("boom"))
    const r = await fileFormPackage(base())
    expect(r).toMatchObject({ status: "error", detail: "boom" })
    expect(alarms).toHaveLength(1)
  })
  it("closure: the right bucket rules and the pinned folder are passed through", async () => {
    saveMock.mockResolvedValue({ summaryFileId: "store:x", copied: [], failed: [], skipped: [], errors: [] })
    const resolveBucket = (p: string) => (p.startsWith("closure/") ? "onboarding-uploads" : "closure-uploads")
    await fileFormPackage(base({ formType: "closure", driveFolderId: "account-storage:22222222-2222-4222-8222-222222222222", bucket: "closure-uploads", resolveBucket }))
    const args = saveMock.mock.calls[0]
    expect(args[3]).toBe("account-storage:22222222-2222-4222-8222-222222222222")
    expect(args[5].bucket).toBe("closure-uploads")
    expect(args[5].resolveBucket("closure/x.pdf")).toBe("onboarding-uploads")
  })
  it("no contact and none expected (onboarding): skipped quietly, no alarm", async () => {
    destination = { marker: null, reason: "no_contact" }
    const r = await fileFormPackage(base({ contactId: null, noContactIsExpected: true }))
    expect(r.status).toBe("skipped")
    expect(alarms).toEqual([])
    expect(saveMock).not.toHaveBeenCalled()
  })
  it("no contact where one is needed: error + alarm, nothing saved", async () => {
    destination = { marker: null, reason: "no_contact" }
    expect((await fileFormPackage(base({ contactId: null }))).status).toBe("error")
    expect(alarms.map((a) => a[0])).toEqual(["lead_form_filing_failed"])
    expect(saveMock).not.toHaveBeenCalled()
  })
  it("a person who still lives on Drive: nothing opened or filed, one alarm of its own kind", async () => {
    destination = { marker: null, reason: "person_on_drive" }
    const r = await fileFormPackage(base())
    expect(r.status).toBe("error")
    expect(alarms.map((a) => a[0])).toEqual(["lead_form_person_on_drive"])
    expect(saveMock).not.toHaveBeenCalled()
  })
  it("a hidden study-only copy is treated as a Drive person", async () => {
    destination = { marker: null, reason: "study_only_owner" }
    expect((await fileFormPackage(base())).detail).toContain("hidden study copy")
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe("archiveFormSubmission — an unresolvable destination counts as an attempt (so the sweep can alert)", () => {
  it("records attempts=1 and rethrows when the closure destination cannot be resolved", async () => {
    vi.resetModules()
    vi.doMock("@/lib/forms/archive-registry", () => ({
      getArchiveRecipe: () => ({ table: "closure_submissions", selectColumns: "*", isReal: () => true, resolvePlan: async () => { throw new Error("closure folder: no company storage and no contact record") } }),
    }))
    const { archiveFormSubmission } = await import("@/lib/forms/archive-submission")
    await expect(archiveFormSubmission("closure", "sub-1")).rejects.toThrow(/no company storage/)
    const meta = updates.map((u) => u.drive_archive_meta as Record<string, unknown> | undefined).filter(Boolean)[0]
    expect(meta).toMatchObject({ attempts: 1 })
    expect(String(meta!.last_error)).toContain("destination unresolved")
    vi.doUnmock("@/lib/forms/archive-registry")
  })
})
