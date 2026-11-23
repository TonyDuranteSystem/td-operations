import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/crm-store/merge-guard", () => ({ storeMergeCheck: vi.fn() }))
vi.mock("@/lib/operations/contact-name-follow", () => ({ memberRowsOf: vi.fn() }))
vi.mock("@/lib/operations/contact-merge-preview", () => ({ sharedMemberAccounts: vi.fn() }))

import { assembleMergeReport, type MergeRaw } from "@/lib/operations/contact-merge-report"

const login = (working: boolean) => ({ id: "u", email: "e", working, lastSignInAt: null })
function raw(over: Partial<MergeRaw> = {}): MergeRaw {
  return {
    removed: { id: "r", full_name: "Daniel Ginal (dup)", email: "ginal@gmail.com", alt_emails: null, merged_into: null, passport_on_file: false, portal_tier: "lead", passport_number: "P4821", date_of_birth: "1990-09-19", phone: "+1 555 0199" },
    kept: { id: "k", full_name: "Daniel Ginal", email: "info@zhang.com", alt_emails: null, merged_into: null, passport_on_file: false, portal_tier: "active", passport_number: "", date_of_birth: null, phone: "+1 555 0114" },
    companies: { removed: [{ id: "co", name: "Zhang Holding LLC", status: "Active" }], kept: [{ id: "co", name: "Zhang Holding LLC", status: "Active" }] },
    records: { removed: 3, kept: 10 },
    logins: { removed: [], kept: [] },
    hasStorage: { removed: false, kept: true },
    ownerlessDocs: [
      { id: "d1", file_name: "ITIN letter.pdf", document_type_name: "ITIN", category: 2, contact_id: null, account_id: "co", account_name: "Zhang Holding LLC", portal_visible: false },
      { id: "d2", file_name: "Owned.pdf", document_type_name: "ID", category: 2, contact_id: "k", account_id: "co", account_name: "Zhang Holding LLC", portal_visible: false },
      { id: "d3", file_name: "Elsewhere.pdf", document_type_name: "ID", category: 2, contact_id: null, account_id: "zzz", account_name: "Other", portal_visible: false },
    ],
    removedOwnedDocs: 2, blockers: [], wantedEmail: null, storagePlan: null,
    ...over,
  }
}

describe("assembleMergeReport", () => {
  it("shows both people and the detail differences (Daniel-style: details only on the removed one)", () => {
    const r = assembleMergeReport(raw())
    expect(r.kept.id).toBe("k")
    expect(r.removed.id).toBe("r")
    expect(r.details.find((d) => d.field === "passport_number")?.status).toBe("copy")
    expect(r.details.find((d) => d.field === "date_of_birth")?.status).toBe("copy")
    expect(r.details.find((d) => d.field === "phone")?.status).toBe("conflict")
    expect(r.identityToChoose).toEqual([])
  })
  it("lists only owner-less personal documents of these contacts' companies", () => {
    const r = assembleMergeReport(raw())
    expect(r.documents.ownerless.map((d) => d.id)).toEqual(["d1"])
    expect(r.documents.movingFromRemoved).toBe(2)
  })
  it("suggests the contact with the wanted email, even when not the one currently kept", () => {
    const r = assembleMergeReport(raw({ wantedEmail: "ginal@gmail.com" }))
    expect(r.suggestion).toMatchObject({ keepId: "r", decidedBy: "wanted_email" })
    expect(r.suggestsSwap).toBe(true)
  })
  it("prefers a working login when no email is wanted (Hamza-style: only the removed one can sign in)", () => {
    const r = assembleMergeReport(raw({ logins: { removed: [login(true)], kept: [login(false)] } }))
    expect(r.suggestion).toMatchObject({ keepId: "r", decidedBy: "working_login" })
  })
  it("names identity details that differ so the person must choose", () => {
    const r = assembleMergeReport(raw({ kept: { ...raw().kept, passport_number: "OTHER9" } }))
    expect(r.identityToChoose).toEqual(["passport_number"])
  })
  it("passes the blockers through and still shows both people", () => {
    const r = assembleMergeReport(raw({ blockers: ["Both contacts already have their own files"] }))
    expect(r.blockers).toHaveLength(1)
    expect(r.kept.hasStorage).toBe(true)
  })
  it("carries the storage plan to the window, and nothing when the storages are not combined", () => {
    expect(assembleMergeReport(raw()).storage).toBeNull()
    const plan = { combined: true, files_moved: 2, files_renamed: [], folders_merged: [], folders_moved: [] }
    expect(assembleMergeReport(raw({ storagePlan: plan })).storage?.plan).toEqual(plan)
    expect(assembleMergeReport(raw({ storagePlan: plan })).storage?.summary.headline).toMatch(/2 files/)
  })
  it("tells the window what the person may choose about the logins (slice 3)", () => {
    expect(assembleMergeReport(raw()).loginChoices.options).toEqual(["kept"])
    const onlyRemoved = assembleMergeReport(raw({ logins: { removed: [login(true)], kept: [] } })).loginChoices
    expect(onlyRemoved).toMatchObject({ options: ["removed", "none"], mustChoose: true })
    const both = assembleMergeReport(raw({ logins: { removed: [login(true)], kept: [login(true)] } })).loginChoices
    expect(both).toMatchObject({ options: ["kept", "removed"], defaultChoice: "kept" })
  })
})
