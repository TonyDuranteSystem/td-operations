/**
 * Stop Drive, slice S1c (dev job 264bb882): unit tests for the new lib functions —
 * no-storage.ts, archive/skip-no-drive-folder.ts, crm-store/save-account-form.ts — and the attest hand-off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  accountsError: false,
  companyState: "store" as "store" | "drive" | "moving",
  taxSave: "store" as "store" | "drive",
  taxSaves: [] as Array<Record<string, unknown>>,
  driveCalls: [] as string[],
  driveMode: "forbid" as "forbid" | "record",
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  const base = h.makeSupabase(state.rows, state.recorded as never)
  const from = (table: string) => {
    const chain = base.from(table) as Record<string, unknown>
    if (table === "accounts" && state.accountsError) chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(r)
    return chain
  }
  return { supabaseAdmin: { from, storage: base.storage } }
})
vi.mock("@/lib/google-drive", async () => (await import("./_stop-drive-mocks")).driveSpyDynamic(state.driveCalls, () => state.driveMode))
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({
  companyDocState: async () => state.companyState,
  liveOwnerOfAccount: async () => "owner-1",
}))
vi.mock("@/lib/crm-store/save-form", () => ({
  saveFormToStore: vi.fn(),
  saveTaxFileForAccount: vi.fn(async (input: Record<string, unknown>) => {
    state.taxSaves.push(input)
    return state.taxSave === "store" ? { route: "store", fileId: "f-1", pointer: "store:f-1", status: "created" } : { route: "drive" }
  }),
}))
vi.mock("@/lib/tax/financials-orchestration", () => ({ buildFinancialsWorkbookForAccount: async () => ({ buffer: new Uint8Array([1, 2, 3]) }) }))

import { NO_STORAGE_SENTENCE, NO_PERSON_STORAGE_SENTENCE, NO_STORAGE_STATUS, notStored, decideNoStorage, folderIdOf, noStorageDecisionFor, accountCanReceiveFiles, receiveVerdictFor, decideNoStorageForContact } from "@/lib/crm-store/no-storage"
import { saveFormForAccount, describeFiling, type SaveAccountFormDeps } from "@/lib/crm-store/save-account-form"

beforeEach(() => {
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.recorded.length = 0
  state.accountsError = false
  state.companyState = "store"
  state.taxSave = "store"
  state.taxSaves.length = 0
  state.driveCalls.length = 0
  state.driveMode = "forbid"
})

describe("no-storage", () => {
  it("one plain sentence per subject, 409, and notStored()", () => {
    expect(NO_STORAGE_SENTENCE).toBe("This company has no document storage in the CRM, so this file could not be saved.")
    expect(NO_PERSON_STORAGE_SENTENCE).toContain("This person has no document storage")
    expect(NO_STORAGE_STATUS).toBe(409)
    expect(notStored({ route: "drive" })).toBe(true)
    expect(notStored({ route: "store" })).toBe(false)
  })
  it("the sentence carries no Drive wording", () => {
    expect(NO_STORAGE_SENTENCE.toLowerCase()).not.toContain("drive")
    expect(NO_PERSON_STORAGE_SENTENCE.toLowerCase()).not.toContain("drive")
  })
})


describe("saveFormForAccount", () => {
  const mk = (over: Partial<SaveAccountFormDeps> = {}) => {
    const stored: unknown[] = []
    const deps: SaveAccountFormDeps = {
      state: async () => "store",
      liveOwner: async () => "owner-1",
      summary: async () => ({ bytes: Buffer.from("pdf"), error: null, subfolder: "3. Tax", filePrefix: "Tax_Data", defaultBucket: "tax-form-uploads" }),
      store: (async (spec: unknown) => { stored.push(spec); return { summaryFileId: "store:s", copied: ["a.pdf"], failed: [], skipped: [], errors: [] } }) as SaveAccountFormDeps["store"],
      ...over,
    }
    return { deps, stored }
  }
  const input = { accountId: "acct-1", formType: "tax_return", submittedData: {}, uploadPaths: ["tax/1/a.pdf"], meta: { token: "tok", submittedAt: "2026-01-01", companyName: "Acme LLC", year: 2025 } }

  it("storage company: filed through the store with an ACCOUNT target, the tax year, the right bucket and stable keys", async () => {
    const { deps, stored } = mk()
    const r = await saveFormForAccount({ ...input, bucket: "onboarding-uploads" }, deps)
    expect(r.route).toBe("store")
    const spec = stored[0] as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(spec.target).toEqual({ kind: "account", id: "acct-1", ownerId: "owner-1" })
    expect(spec.subfolder).toBe("3. Tax")
    expect(spec.year).toBe(2025)
    expect(spec.bucketOf("anything")).toBe("onboarding-uploads")
    expect(spec.summary.name).toBe("Tax_Data_Acme_LLC.pdf")
    expect(spec.summary.callerKey).toBe("form-summary:acct-1:tax_return:tok")
    expect(spec.submissionKey).toBe("acct-1:tax_return:tok")
  })

  it("uses the form type's default bucket when none is given; a non-tax form carries no year", async () => {
    const { deps, stored } = mk()
    await saveFormForAccount({ ...input, formType: "closure" }, deps)
    const spec = stored[0] as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(spec.bucketOf("x")).toBe("tax-form-uploads")
    expect(spec.year).toBeNull()
  })

  it("a summary PDF error is reported with the store's own errors, the uploads are still filed", async () => {
    const { deps } = mk({ summary: async () => ({ bytes: null, error: "Summary PDF error: x", subfolder: "3. Tax", filePrefix: "T", defaultBucket: "b" }) })
    const r = await saveFormForAccount(input, deps)
    expect(r.route === "store" && r.result.errors).toEqual(["Summary PDF error: x"])
  })

  it("a company with no storage: { route: 'none' } and the store is never called", async () => {
    const { deps, stored } = mk({ state: async () => "drive" })
    expect(await saveFormForAccount(input, deps)).toEqual({ route: "none" })
    expect(stored).toEqual([])
  })

  it("a company left on its old Drive folder is frozen (Stop Drive S2): { route: 'none' }, nothing filed anywhere", async () => {
    const { deps, stored } = mk({ state: async () => "drive" })
    expect(await saveFormForAccount(input, deps)).toEqual({ route: "none" })
    expect(stored).toEqual([])
  })

  it("a company being moved: refused with the moving error, nothing filed", async () => {
    const { deps, stored } = mk({ state: async () => "moving" })
    await expect(saveFormForAccount(input, deps)).rejects.toThrow(/being moved/)
    expect(stored).toEqual([])
  })

  it("storage state but no owner found: an error, never a silent skip", async () => {
    const { deps } = mk({ liveOwner: async () => null })
    await expect(saveFormForAccount(input, deps)).rejects.toThrow(/could not be found/)
  })
})

describe("runAttestHandoff", () => {
  beforeEach(() => { state.rows.accounts = { company_name: "Acme LLC" } })
  const run = async () => { const { runAttestHandoff } = await import("@/lib/tax/attest-handoff"); await runAttestHandoff("acct-1", 2025) }
  const audit = () => state.recorded.find((r) => r.table === "action_log")?.payload as { details: { outcome: string; detail: string } }

  it("storage company: the confirmed workbook is saved in its storage (3. Tax › year), zero Drive calls", async () => {
    await run()
    expect(state.taxSaves[0]).toMatchObject({ accountId: "acct-1", year: 2025, callerKey: "attest-workbook:acct-1:2025" })
    expect(audit().details.outcome).toBe("archived")
    expect(state.driveCalls).toEqual([])
  })

  it("company with no storage: reported as no_storage in the audit log, nothing written anywhere", async () => {
    state.companyState = "drive"
    await run()
    expect(state.taxSaves).toEqual([])
    expect(audit().details.outcome).toBe("no_storage")
    expect(audit().details.detail).toContain("no document storage in the CRM")
    expect(state.driveCalls).toEqual([])
  })

  it("a company left on its old folder is frozen (Stop Drive S2): reported as no_storage, zero Drive calls", async () => {
    state.companyState = "drive"
    state.rows.accounts = { company_name: "Acme LLC", status: "Active", drive_folder_id: "OLDFOLDER", gdrive_folder_url: null }
    await run()
    expect(state.driveCalls).toEqual([])
    expect(state.taxSaves).toEqual([])
    expect(audit().details.outcome).toBe("no_storage")
  })

  it("storage that refuses the file: reported as failed, not archived", async () => {
    state.taxSave = "drive"
    await run()
    expect(audit().details.outcome).toBe("failed")
  })
})

describe("describeFiling", () => {
  const base = { summaryFileId: "store:s", copied: [] as string[], failed: [] as string[], skipped: [] as string[], errors: [] as string[] }
  it("filed = no error and no failed upload", () => {
    expect(describeFiling({ route: "store", result: base }).ok).toBe(true)
    expect(describeFiling({ route: "store", result: { ...base, copied: ["a"] } }).lines).toContain("✅ 1 file(s) saved")
  })
  it("not filed: nowhere to file it, an error, or a failed upload", () => {
    expect(describeFiling({ route: "none" })).toEqual({ ok: false, lines: [`⚠️ ${NO_STORAGE_SENTENCE}`] })
    expect(describeFiling({ route: "store", result: { ...base, errors: ["x"] } }).ok).toBe(false)
    expect(describeFiling({ route: "store", result: { ...base, failed: ["a.pdf"] } }).ok).toBe(false)
  })
})

describe("decideNoStorage / folderIdOf", () => {
  it("a company left on its old folder (Active/Suspended/Offboarding with a folder) is FROZEN — refused, never written (Stop Drive S2)", () => {
    for (const status of ["Active", "Suspended", "Offboarding"]) {
      expect(decideNoStorage({ status, drive_folder_id: "F" })).toMatchObject({ route: "refuse", reason: "frozen" })
    }
  })
  it("Closed / Cancelled are refused even with a folder; no folder is refused; unknown account is refused", () => {
    expect(decideNoStorage({ status: "Closed", drive_folder_id: "F" })).toMatchObject({ route: "refuse", reason: "archived", sentence: "This company is closed, so nothing new can be saved for it." })
    expect(decideNoStorage({ status: " CANCELLED ", drive_folder_id: "F" })).toMatchObject({ route: "refuse", reason: "archived" })
    expect(decideNoStorage({ status: "Active", drive_folder_id: null })).toMatchObject({ route: "refuse", reason: "no_folder", sentence: NO_STORAGE_SENTENCE })
    expect(decideNoStorage({ status: "Active", gdrive_folder_url: "https://drive.google.com/drive/folders/AbC" })).toMatchObject({ route: "refuse", reason: "frozen" })
    expect(decideNoStorage(null)).toMatchObject({ route: "refuse", reason: "no_company" })
  })
  it("the folder id also comes from the older link", () => {
    expect(folderIdOf({ gdrive_folder_url: "https://drive.google.com/drive/folders/AbC-12_x?usp=sharing" })).toBe("AbC-12_x")
    expect(folderIdOf({ drive_folder_id: "F", gdrive_folder_url: "https://drive.google.com/drive/folders/Other" })).toBe("F")
    expect(folderIdOf({})).toBeNull()
  })
  it("noStorageDecisionFor reads the account; accountCanReceiveFiles is true for storage only (an old Drive folder no longer counts)", async () => {
    state.rows.accounts = { status: "Active", drive_folder_id: "F", gdrive_folder_url: null }
    expect(await noStorageDecisionFor("a")).toMatchObject({ route: "refuse", reason: "frozen" })
    state.companyState = "drive"
    expect(await accountCanReceiveFiles("a")).toBe(false)
    state.rows.accounts = { status: "Active", drive_folder_id: null, gdrive_folder_url: null }
    expect(await accountCanReceiveFiles("a")).toBe(false)
    state.companyState = "store"
    expect(await accountCanReceiveFiles("a")).toBe(true)
  })
})

describe("receiveVerdictFor — the pre-check every 'change something, then file' action asks first", () => {
  it("storage → ok; moving → not now (try again), nothing else; a company frozen on its old folder, closed, or with no folder → refused with the true reason", async () => {
    state.companyState = "store"
    expect(await receiveVerdictFor("a")).toEqual({ ok: true })
    state.companyState = "moving"
    expect(await receiveVerdictFor("a")).toMatchObject({ ok: false, reason: "moving", sentence: expect.stringContaining("try again in a few minutes") })
    state.companyState = "drive"
    state.rows.accounts = { status: "Active", drive_folder_id: "F" }
    expect(await receiveVerdictFor("a")).toMatchObject({ ok: false, reason: "frozen" })
    state.rows.accounts = { status: "Closed", drive_folder_id: "F" }
    expect(await receiveVerdictFor("a")).toMatchObject({ ok: false, reason: "archived" })
    state.rows.accounts = { status: "Active", drive_folder_id: null }
    expect(await receiveVerdictFor("a")).toMatchObject({ ok: false, reason: "no_folder" })
  })
})

describe("decideNoStorageForContact — the same rule for a person (one definition)", () => {
  const frozen = decideNoStorage({ status: "Active", drive_folder_id: "COMPANYFOLDER" })
  const archived = decideNoStorage({ status: "Closed", drive_folder_id: "F" })
  const noFolder = decideNoStorage({ status: "Active" })
  it("a person with no storage who belongs to a company frozen on its old folder → refused as 'frozen' (Stop Drive S2: never a Drive folder)", () => {
    expect(decideNoStorageForContact({ liveOwner: false, folderId: null, companyVerdicts: [noFolder, frozen], companyInStorageOrMoving: false })).toMatchObject({ route: "refuse", reason: "frozen" })
    expect(decideNoStorageForContact({ liveOwner: false, folderId: "OWN", companyVerdicts: [frozen], companyInStorageOrMoving: false })).toMatchObject({ route: "refuse", reason: "frozen" })
  })
  it("a person with their own storage, or with a company in storage / being moved, is never given a Drive folder", () => {
    expect(decideNoStorageForContact({ liveOwner: true, folderId: "OWN", companyVerdicts: [frozen], companyInStorageOrMoving: false }).route).toBe("refuse")
    expect(decideNoStorageForContact({ liveOwner: false, folderId: null, companyVerdicts: [frozen], companyInStorageOrMoving: true }).route).toBe("refuse")
  })
  it("no company at all: refused; only closed companies: refused as closed", () => {
    expect(decideNoStorageForContact({ liveOwner: false, folderId: null, companyVerdicts: [], companyInStorageOrMoving: false })).toMatchObject({ route: "refuse", reason: "no_folder" })
    expect(decideNoStorageForContact({ liveOwner: false, folderId: "OWN", companyVerdicts: [], companyInStorageOrMoving: false })).toMatchObject({ route: "refuse", reason: "no_company" })
    expect(decideNoStorageForContact({ liveOwner: false, folderId: null, companyVerdicts: [archived], companyInStorageOrMoving: false })).toMatchObject({ route: "refuse", reason: "archived" })
  })
})
