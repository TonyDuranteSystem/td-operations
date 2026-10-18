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
vi.mock("@/lib/google-drive", async () => (await import("./_stop-drive-mocks")).driveSpy(state.driveCalls))
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

import { NO_STORAGE_SENTENCE, NO_PERSON_STORAGE_SENTENCE, NO_STORAGE_STATUS, notStored } from "@/lib/crm-store/no-storage"
import { splitByFolder, accountsWithoutFolder } from "@/lib/archive/skip-no-drive-folder"
import { saveFormForAccount, type SaveAccountFormDeps } from "@/lib/crm-store/save-account-form"

beforeEach(() => {
  state.rows = {}
  state.recorded.length = 0
  state.accountsError = false
  state.companyState = "store"
  state.taxSave = "store"
  state.taxSaves.length = 0
  state.driveCalls.length = 0
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

describe("splitByFolder / accountsWithoutFolder", () => {
  it("keeps a row with no company, skips a company with no folder", () => {
    const r = splitByFolder([{ account_id: "a" }, { account_id: "b" }, { account_id: null }, {}], new Set(["a"]))
    expect(r.skipped).toEqual([{ account_id: "a" }])
    expect(r.keep).toHaveLength(3)
  })
  it("returns only accounts that exist and have no folder; an unknown account is not skipped", async () => {
    state.rows.accounts = [{ id: "a", drive_folder_id: null }, { id: "b", drive_folder_id: "F" }]
    const missing = await accountsWithoutFolder(["a", "b", "ghost", "a", ""])
    expect(Array.from(missing)).toEqual(["a"])
  })
  it("empty input reads nothing", async () => {
    expect((await accountsWithoutFolder([])).size).toBe(0)
    expect(state.recorded).toEqual([])
  })
  it("a read error throws (never mistaken for 'no folder')", async () => {
    state.accountsError = true
    await expect(accountsWithoutFolder(["a"])).rejects.toThrow(/could not read/)
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

  it("storage that refuses the file: reported as failed, not archived", async () => {
    state.taxSave = "drive"
    await run()
    expect(audit().details.outcome).toBe("failed")
  })
})
