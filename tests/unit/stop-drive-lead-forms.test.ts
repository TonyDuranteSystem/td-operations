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
import { storageDestinationForForm } from "@/lib/crm-store/lead-form-store"
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

describe("storageDestinationForForm — where a lead/client form package goes", () => {
  it("opens the person's storage when they have none and points at it", async () => {
    const dest = await storageDestinationForForm({ contactId: CONTACT, personName: "Mario Rossi" })
    expect(dest).toBe(`person-storage:${CONTACT}`)
    expect(owners.contact.get(CONTACT)).toBe(`person-owner-${CONTACT}`)
  })
  it("a company that already has storage wins over the person", async () => {
    owners.account.set(ACCOUNT, "acc-owner")
    expect(await storageDestinationForForm({ accountId: ACCOUNT, contactId: CONTACT })).toBe(`account-storage:${ACCOUNT}`)
    expect(owners.contact.size).toBe(0) // nobody's personal storage was opened for nothing
  })
  it("an account with no storage falls to the person", async () => {
    expect(await storageDestinationForForm({ accountId: ACCOUNT, contactId: CONTACT, personName: "X" })).toBe(`person-storage:${CONTACT}`)
  })
  it("neither a company storage nor a contact → null (never a Drive fallback)", async () => {
    expect(await storageDestinationForForm({})).toBeNull()
    expect(await storageDestinationForForm({ accountId: ACCOUNT })).toBeNull()
    expect(driveCalls).toEqual([])
  })
  it("uses the contact's name from the CRM when none is given, and opens the storage only once", async () => {
    await storageDestinationForForm({ contactId: CONTACT })
    await storageDestinationForForm({ contactId: CONTACT })
    const pilot = await import("@/lib/crm-store/formation-pilot")
    expect(pilot.ensurePersonOwner).toHaveBeenCalledTimes(1)
    expect(pilot.ensurePersonOwner).toHaveBeenCalledWith(CONTACT, "Mario Rossi")
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
