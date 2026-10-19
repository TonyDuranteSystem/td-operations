import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Stop-Drive S1a round 3: a person storage opened by a lead form must neither lock nor capture the "2. Contacts" folder of a company
 * that is still on Drive (REBIS, YBR, Degasper, Fresh Legal).
 */
const claims: Record<string, Array<{ id: string }>> = { accounts: [], contacts: [] }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => { const c: Record<string, unknown> = {}; c.select = () => c; c.or = () => c; c.limit = async () => ({ data: claims[t] ?? [], error: null }); return c } },
}))
const owners = new Map<string, string>()
const sharing = new Set<string>()
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({
  lockedFolderIdsCached: async () => new Set(["some-locked-folder"]),
  companyDocState: async () => "drive",
  liveOwnerOfAccount: async () => null,
  liveOwnerOfContact: async (id: string) => owners.get(id) ?? null,
  contactSharesDriveCompany: async (id: string) => sharing.has(id),
}))
vi.mock("@/lib/google-drive", () => ({ driveParentIds: async () => [] }))
vi.mock("@/lib/crm-store/save-for-account", () => ({ CompanyMovingError: class extends Error {} }))

import { switchedTargetForFolder } from "@/lib/crm-store/save-form"
import { contactsSharingDriveCompany } from "@/lib/crm-store/switched-drive-guard-pure"

beforeEach(() => { claims.accounts = []; claims.contacts = []; owners.clear(); sharing.clear() })

describe("contactsSharingDriveCompany (pure)", () => {
  const status = new Map<string, string | null>([["drive-live", "Offboarding"], ["drive-closed", "Closed"], ["drive-cancelled", "Cancelled"]])
  it("a person linked to a live company that is not in the storage shares a Drive company", () => {
    expect(contactsSharingDriveCompany([{ contact_id: "m1", account_id: "drive-live" }], status, new Set()).has("m1")).toBe(true)
  })
  it("a company already in the storage, a finished company (Closed/Cancelled) or an unknown company does not count", () => {
    expect(contactsSharingDriveCompany([{ contact_id: "m1", account_id: "drive-live" }], status, new Set(["drive-live"])).size).toBe(0)
    expect(contactsSharingDriveCompany([{ contact_id: "m1", account_id: "drive-closed" }, { contact_id: "m2", account_id: "drive-cancelled" }], status, new Set()).size).toBe(0)
    expect(contactsSharingDriveCompany([{ contact_id: "m1", account_id: "nope" }], status, new Set()).size).toBe(0)
  })
})

describe("switchedTargetForFolder — the shared 'More than one record claims this Drive folder' case", () => {
  it("REBIS shape: the only claimant has a storage but belongs to a Drive company → it is a Drive folder (null), no redirect, no throw", async () => {
    claims.contacts = [{ id: "m1" }]; owners.set("m1", "person-owner"); sharing.add("m1")
    expect(await switchedTargetForFolder("X")).toBeNull()
  })
  it("two members share the folder, one has a storage, the company is on Drive → Drive folder, no throw (was: refused)", async () => {
    claims.contacts = [{ id: "m1" }, { id: "m2" }]; owners.set("m1", "person-owner"); sharing.add("m1"); sharing.add("m2")
    expect(await switchedTargetForFolder("X")).toBeNull()
  })
  it("a person whose storage is real (not a Drive company's member) still captures their own folder", async () => {
    claims.contacts = [{ id: "p1" }]; owners.set("p1", "person-owner")
    expect(await switchedTargetForFolder("X")).toEqual({ kind: "contact", id: "p1", ownerId: "person-owner" })
  })
  it("two real storages claiming one folder is still refused (unchanged)", async () => {
    claims.contacts = [{ id: "p1" }, { id: "p2" }]; owners.set("p1", "o1"); owners.set("p2", "o2")
    await expect(switchedTargetForFolder("X")).rejects.toThrow(/More than one record/)
  })
})
