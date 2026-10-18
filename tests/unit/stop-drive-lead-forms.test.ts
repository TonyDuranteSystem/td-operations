import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Stop-Drive S1a (dev job 264bb882): the formation / onboarding / closure completion packages are filed in the new storage,
 * never in a Drive "Leads" folder. Every Google Drive call below is a spy that fails the test if it is ever reached.
 */

const driveCalls: string[] = []
vi.mock("@/lib/google-drive", () => {
  const spy = (name: string) => async () => { driveCalls.push(name); throw new Error(`Drive was called: ${name}`) }
  return {
    listFolder: spy("listFolder"), createFolder: spy("createFolder"), uploadBinaryToDrive: spy("uploadBinaryToDrive"),
    uploadBinaryToDriveUpsert: spy("uploadBinaryToDriveUpsert"), folderFileNameMap: spy("folderFileNameMap"),
    fileExistsInFolder: spy("fileExistsInFolder"), driveParentIds: spy("driveParentIds"),
  }
})

const owners = { contact: new Map<string, string>(), account: new Map<string, string>() }
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({
  liveOwnerOfContact: vi.fn(async (id: string) => owners.contact.get(id) ?? null),
  liveOwnerOfAccount: vi.fn(async (id: string) => owners.account.get(id) ?? null),
  personFilesInStorage: vi.fn(async () => false),
  lockedFolderIdsCached: vi.fn(async () => new Set<string>()),
  companyDocState: vi.fn(async () => "drive"),
}))

const stored: Array<Record<string, unknown>> = []
vi.mock("@/lib/crm-store/formation-pilot", () => ({
  ensurePersonOwner: vi.fn(async (contactId: string) => { owners.contact.set(contactId, `person-owner-${contactId}`); return `person-owner-${contactId}` }),
  savePilotFile: vi.fn(async (p: Record<string, unknown>) => { stored.push(p); return { status: "created", fileId: `0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f${stored.length}` } }),
}))
vi.mock("@/lib/supabase-admin", () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain; chain.eq = () => chain
  chain.maybeSingle = async () => ({ data: { full_name: "Mario Rossi" } })
  return {
    supabaseAdmin: {
      from: () => chain,
      storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }), error: null }) }) },
    },
  }
})

import { saveFormToDrive } from "@/lib/form-to-drive"
import { storageDestinationForForm, type FormStorageDeps } from "@/lib/crm-store/lead-form-store"
import { parseStorageMarker } from "@/lib/crm-store/save-form"

const CONTACT = "11111111-1111-4111-8111-111111111111"
const ACCOUNT = "22222222-2222-4222-8222-222222222222"
const META = { token: "tok-1", submittedAt: "2026-10-18T10:00:00Z", companyName: "Mario Rossi" }

beforeEach(() => { vi.clearAllMocks(); driveCalls.length = 0; stored.length = 0; owners.contact.clear(); owners.account.clear() })

describe("parseStorageMarker", () => {
  it("reads person / account markers and rejects Drive ids", () => {
    expect(parseStorageMarker(`person-storage:${CONTACT}`)).toEqual({ kind: "contact", id: CONTACT })
    expect(parseStorageMarker(`account-storage:${ACCOUNT}`)).toEqual({ kind: "account", id: ACCOUNT })
    expect(parseStorageMarker("1mbz_bUDwC4K259RcC-tDKihjlvdAVXno")).toBeNull()
    expect(parseStorageMarker("person-storage:not-an-id")).toBeNull()
    expect(parseStorageMarker("")).toBeNull()
  })
})

const mkDeps = (over: Partial<FormStorageDeps> = {}) => {
  const opened: Array<[string, string]> = []
  const deps: FormStorageDeps = {
    liveOwnerOfAccount: async (id) => owners.account.get(id) ?? null,
    liveOwnerOfContact: async (id) => owners.contact.get(id) ?? null,
    hasStudyOnlyOwner: async () => false,
    contactFacts: async () => ({ fullName: "Mario Rossi", hasDriveFolder: false, accountIds: [] }),
    companyState: async () => "drive",
    ensurePersonOwner: async (id, name) => { opened.push([id, name]); owners.contact.set(id, `person-owner-${id}`); return `person-owner-${id}` },
    ...over,
  }
  return { deps, opened }
}

describe("storageDestinationForForm — where a lead/client form package goes", () => {
  it("opens the person's storage when they have none and points at it, naming the root from the CRM contact name", async () => {
    const { deps, opened } = mkDeps()
    const dest = await storageDestinationForForm({ contactId: CONTACT, personName: "mario rossi (form text)" }, deps)
    expect(dest).toEqual({ marker: `person-storage:${CONTACT}` })
    expect(opened).toEqual([[CONTACT, "Mario Rossi"]]) // CRM name, not the raw form text
  })
  it("falls back to the form's name only when the CRM has none", async () => {
    const { deps, opened } = mkDeps({ contactFacts: async () => ({ fullName: null, hasDriveFolder: false, accountIds: [] }) })
    await storageDestinationForForm({ contactId: CONTACT, personName: "Form Name" }, deps)
    expect(opened).toEqual([[CONTACT, "Form Name"]])
  })
  it("a company that already has storage wins over the person", async () => {
    owners.account.set(ACCOUNT, "acc-owner")
    const { deps, opened } = mkDeps()
    expect(await storageDestinationForForm({ accountId: ACCOUNT, contactId: CONTACT }, deps)).toEqual({ marker: `account-storage:${ACCOUNT}` })
    expect(opened).toEqual([]) // nobody's personal storage was opened for nothing
  })
  it("neither a company storage nor a contact → no_contact (never a Drive fallback)", async () => {
    const { deps } = mkDeps()
    expect(await storageDestinationForForm({}, deps)).toEqual({ marker: null, reason: "no_contact" })
    expect(await storageDestinationForForm({ accountId: ACCOUNT }, deps)).toEqual({ marker: null, reason: "no_contact" })
    expect(driveCalls).toEqual([])
  })
  it("a person who already has a live storage is used as is, opened only once", async () => {
    owners.contact.set(CONTACT, "person-owner")
    const { deps, opened } = mkDeps()
    expect(await storageDestinationForForm({ contactId: CONTACT }, deps)).toEqual({ marker: `person-storage:${CONTACT}` })
    expect(opened).toEqual([])
  })
  it("STUDY-ONLY owner: the person still lives on Drive — nothing is opened or filed into the hidden copy", async () => {
    const { deps, opened } = mkDeps({ hasStudyOnlyOwner: async () => true })
    expect(await storageDestinationForForm({ contactId: CONTACT }, deps)).toEqual({ marker: null, reason: "study_only_owner" })
    expect(opened).toEqual([])
  })
  it("a member of a still-Drive company (Drive folder, company on Drive) gets NO storage — their Drive folder must not become locked", async () => {
    const { deps, opened } = mkDeps({ contactFacts: async () => ({ fullName: "M", hasDriveFolder: true, accountIds: [ACCOUNT] }), companyState: async () => "drive" })
    expect(await storageDestinationForForm({ contactId: CONTACT }, deps)).toEqual({ marker: null, reason: "person_on_drive" })
    expect(opened).toEqual([])
  })
  it("a Drive folder with no company at all, or a company mid-move, also stays on Drive", async () => {
    const a = mkDeps({ contactFacts: async () => ({ fullName: "M", hasDriveFolder: true, accountIds: [] }) })
    expect(await storageDestinationForForm({ contactId: CONTACT }, a.deps)).toMatchObject({ reason: "person_on_drive" })
    const b = mkDeps({ contactFacts: async () => ({ fullName: "M", hasDriveFolder: true, accountIds: [ACCOUNT] }), companyState: async () => "moving" })
    expect(await storageDestinationForForm({ contactId: CONTACT }, b.deps)).toMatchObject({ reason: "person_on_drive" })
  })
  it("a person with a Drive folder whose companies are ALL already in the storage gets their storage opened", async () => {
    const { deps, opened } = mkDeps({ contactFacts: async () => ({ fullName: "M", hasDriveFolder: true, accountIds: [ACCOUNT] }), companyState: async () => "store" })
    expect(await storageDestinationForForm({ contactId: CONTACT }, deps)).toEqual({ marker: `person-storage:${CONTACT}` })
    expect(opened).toHaveLength(1)
  })
  it("a brand-new contact with no Drive folder is fine even if linked to a Drive company", async () => {
    const { deps } = mkDeps({ contactFacts: async () => ({ fullName: "M", hasDriveFolder: false, accountIds: [ACCOUNT] }), companyState: async () => "drive" })
    expect(await storageDestinationForForm({ contactId: CONTACT }, deps)).toEqual({ marker: `person-storage:${CONTACT}` })
  })
})

describe("saveFormToDrive with a storage destination — zero Google Drive calls", () => {
  for (const formType of ["formation", "onboarding", "closure"] as const) {
    it(`${formType}: summary + uploads land in the person's storage, staff-only summary type for formation, Drive untouched`, async () => {
      owners.contact.set(CONTACT, "person-owner")
      const res = await saveFormToDrive(formType, { owner_first_name: "Mario" }, ["lead/passport_owner.pdf"], `person-storage:${CONTACT}`, META)
      expect(driveCalls).toEqual([])
      expect(res.errors).toEqual([])
      expect(res.summaryFileId).toMatch(/^store:/)
      expect(res.copied).toEqual(["passport_owner.pdf"])
      expect(stored).toHaveLength(2)
      expect(stored.every((s) => s.ownerId === "person-owner")).toBe(true)
      expect(stored.every((s) => s.folderKind === "personal")).toBe(true)
      expect(stored[0].documentType).toBe(formType === "formation" ? "formation_summary" : "other_document")
      expect(stored[0].published).toBe(false) // never shown to a client
    })
  }

  it("closure on a company that has storage: filed under the company, Drive untouched", async () => {
    owners.account.set(ACCOUNT, "acc-owner")
    const res = await saveFormToDrive("closure", { llc_name: "Acme" }, ["closure/ein.pdf"], `account-storage:${ACCOUNT}`, META)
    expect(driveCalls).toEqual([])
    expect(res.errors).toEqual([])
    expect(stored.every((s) => s.ownerId === "acc-owner")).toBe(true)
    expect(stored.every((s) => s.folderKind === "company")).toBe(true)
  })

  it("a storage that cannot be found saves nothing and does NOT fall through to Drive", async () => {
    const res = await saveFormToDrive("formation", {}, ["x/y.pdf"], `person-storage:${CONTACT}`, META)
    expect(driveCalls).toEqual([])
    expect(stored).toEqual([])
    expect(res.summaryFileId).toBeNull()
    expect(res.errors[0]).toMatch(/could not be found/)
  })
})
