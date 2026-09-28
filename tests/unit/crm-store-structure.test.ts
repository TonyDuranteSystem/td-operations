import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { stateGroup, groupOwners, isLockedFolder, cleanFolderName, suggestTaxYear, CLOSED_STATUSES, mayOpenPrivateArea } from "@/lib/crm-store/structure"

const row = (o: Partial<Parameters<typeof groupOwners>[0][number]>) => ({
  id: o.id ?? "x", kind: o.kind ?? "company", label: o.label ?? "A LLC", status: o.status ?? null, fileCount: o.fileCount ?? 0,
  state: o.state ?? null, accountStatus: o.accountStatus ?? null,
})

describe("stateGroup", () => {
  it("folds two-letter codes and any case into the full name", () => {
    expect(stateGroup("WY")).toBe("Wyoming")
    expect(stateGroup(" nm ")).toBe("New Mexico")
    expect(stateGroup("florida")).toBe("Florida")
    expect(stateGroup("Delaware")).toBe("Delaware")
  })
  it("empty → null; an unknown value is kept as written", () => {
    expect(stateGroup(null)).toBeNull()
    expect(stateGroup("  ")).toBeNull()
    expect(stateGroup("Puerto Rico")).toBe("Puerto Rico")
  })
})

describe("groupOwners", () => {
  it("puts each owner in exactly one group, states sorted, WY and Wyoming together", () => {
    const g = groupOwners([
      row({ id: "1", label: "Zeta LLC", state: "WY", accountStatus: "Active" }),
      row({ id: "2", label: "Alpha LLC", state: "Wyoming", accountStatus: "Active" }),
      row({ id: "3", label: "Beta LLC", state: "FL", accountStatus: "Active" }),
      row({ id: "4", label: "Gone LLC", state: "WY", accountStatus: "Closed" }),
      row({ id: "5", label: "No State LLC", state: null, accountStatus: "Active" }),
      row({ id: "6", kind: "person", label: "Mario Rossi" }),
      row({ id: "7", kind: "formation", label: "New Co", status: "being formed" }),
      row({ id: "8", kind: "formation", label: "Old Co", status: "archived" }),
      row({ id: "9", kind: "business", label: "Business" }),
      row({ id: "10", kind: "private", label: "My files" }),
      row({ id: "11", kind: "unfiled", label: "Unfiled" }),
      row({ id: "12", label: "Cxl LLC", state: "NM", accountStatus: "Cancelled" }),
    ])
    const by = Object.fromEntries(g.map((x) => [x.key, x.owners.map((o) => o.id)]))
    expect(g.map((x) => x.key)).toEqual(["state:Florida", "state:Wyoming", "people", "forming", "closed", "nostate", "unfiled", "business", "private"])
    expect(by["state:Wyoming"]).toEqual(["2", "1"])
    expect(by.closed.sort()).toEqual(["12", "4", "8"].sort())
    expect(by.forming).toEqual(["7"])
    const all = g.flatMap((x) => x.owners.map((o) => o.id))
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(12)
  })
  it("always shows Business (even empty); My files only when present", () => {
    const g = groupOwners([])
    expect(g.map((x) => x.key)).toEqual(["business"])
  })
  it("Offboarding counts as closed", () => { expect(CLOSED_STATUSES).toContain("Offboarding") })
})

describe("isLockedFolder", () => {
  it("template folders and top folders are locked; staff-made folders are not", () => {
    expect(isLockedFolder({ template_slug: "company_standard", parent_id: "p" })).toBe(true)
    expect(isLockedFolder({ template_slug: null, parent_id: null })).toBe(true)
    expect(isLockedFolder({ template_slug: null, parent_id: "p" })).toBe(false)
  })
})

describe("cleanFolderName", () => {
  it("trims and collapses spaces", () => { expect(cleanFolderName("  Bank   of  America ")).toBe("Bank of America") })
  it("refuses empty, slashes, control characters, over-long", () => {
    expect(() => cleanFolderName("   ")).toThrow(/Enter a folder name/)
    expect(() => cleanFolderName("a/b")).toThrow(/can't contain/)
    expect(() => cleanFolderName("a\\b")).toThrow(/can't contain/)
    expect(() => cleanFolderName("a\u0007b")).toThrow(/can't contain/)
    expect(() => cleanFolderName("x".repeat(256))).toThrow(/too long/)
  })
})

describe("suggestTaxYear", () => {
  const now = new Date("2026-09-27T12:00:00Z")
  it("last year when missing", () => { expect(suggestTaxYear([], now)).toBe("2025") })
  it("the most recent missing year", () => { expect(suggestTaxYear(["2025", "Other"], now)).toBe("2024") })
})

import { folderNameProblem, finalUploadName, keepBothName, cleanNewFileName } from "@/lib/crm-store/names"
import { shownThroughCompany, categoryForKind, saveRefusalMessage } from "@/lib/crm-store/browse"

describe("folderNameProblem (the message the screen shows before saving)", () => {
  it("fine name → null; same name as a folder next to it (any case) → message", () => {
    expect(folderNameProblem("Bank of America", ["2025"])).toBeNull()
    expect(folderNameProblem(" bank of america ", ["Bank of America"])).toMatch(/already exists/)
    expect(folderNameProblem("a/b", [])).toMatch(/can't contain/)
    expect(folderNameProblem("", [])).toMatch(/Enter a folder name/)
  })
})

describe("upload names", () => {
  it("the name shown keeps the original extension; empty → the file's own name", () => {
    expect(finalUploadName("scan 01.PDF", "")).toBe("scan 01.PDF")
    expect(finalUploadName("scan.pdf", "Articles")).toBe("Articles.pdf")
    expect(finalUploadName("scan.pdf", "Articles.PDF")).toBe("Articles.PDF")
    expect(finalUploadName("scan.pdf", "a/b")).toBe("a-b.pdf")
    expect(finalUploadName("scan.pdf", "a/b")).toBe(cleanNewFileName("a/b", "scan.pdf"))
  })
  it("keep both → the first free (n)", () => {
    expect(keepBothName("Invoice.pdf", ["Invoice.pdf"])).toBe("Invoice (2).pdf")
    expect(keepBothName("Invoice.pdf", ["Invoice.pdf", "invoice (2).pdf"])).toBe("Invoice (3).pdf")
    expect(keepBothName("README", ["README"])).toBe("README (2)")
  })
})

describe("shownThroughCompany (catalog: a person's ITIN / Tax never on a company page)", () => {
  const kinds = new Map<string, { shown_through_company?: boolean }>([["personal", { shown_through_company: true }], ["itin", { shown_through_company: false }], ["person_tax", { shown_through_company: false }], ["custom", { shown_through_company: true }], ["new_kind", {}]])
  it("follows the catalog; a kind WITHOUT the setting is not shown (fails closed)", () => {
    expect(shownThroughCompany("personal", kinds)).toBe(true)
    expect(shownThroughCompany("custom", kinds)).toBe(true)
    expect(shownThroughCompany("itin", kinds)).toBe(false)
    expect(shownThroughCompany("person_tax", kinds)).toBe(false)
    expect(shownThroughCompany("new_kind", kinds)).toBe(false)
    expect(shownThroughCompany("unknown", kinds)).toBe(false)
  })
})

describe("categoryForKind (one rule for upload, file move, folder move)", () => {
  it("a person's tax year is Tax; every kind answers; an unknown kind → Correspondence", () => {
    expect(categoryForKind("person_tax_year")).toEqual({ num: 3, name: "Tax" })
    expect(categoryForKind("tax_year")).toEqual({ num: 3, name: "Tax" })
    expect(categoryForKind("banking").num).toBe(4)
    expect(categoryForKind("root").num).toBe(5)
    expect(categoryForKind("something_new").num).toBe(5)
  })
  it("a refused save says why in plain words", () => {
    expect(saveRefusalMessage("frozen")).toMatch(/FILED/)
    expect(saveRefusalMessage("trashed")).toMatch(/trash/)
  })
})

import { shareDiff } from "@/lib/crm-store/staff-share"
describe("My files is the owners' shared area; every other private area only for its own login", () => {
  it("own area yes; the owners' area for any owner; never for a non-owner", () => {
    expect(mayOpenPrivateArea("A", { id: "A", ownerOnly: false }, null)).toBe(true)
    expect(mayOpenPrivateArea("A", { id: "J", ownerOnly: true }, "A")).toBe(true)
    expect(mayOpenPrivateArea("A", { id: "L", ownerOnly: false }, "A")).toBe(false)
    expect(mayOpenPrivateArea("X", { id: "J", ownerOnly: true }, "A")).toBe(false)
    expect(mayOpenPrivateArea(null, { id: "J", ownerOnly: true }, "A")).toBe(false)
    expect(mayOpenPrivateArea("A", { id: null, ownerOnly: true }, "A")).toBe(false)
  })
})
describe("shareDiff", () => {
  it("adds the new ticks and removes the unticked ones", () => {
    expect(shareDiff(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] })
    expect(shareDiff([], [])).toEqual({ add: [], remove: [] })
  })
})

import { isOwnerOnly, isProtectedAdminEmail, isSecureAdmin, PRIMARY_OWNER_EMAIL } from "@/lib/auth"
describe("owners vs the protected admin (adding an owner never changes 2FA protection)", () => {
  const u = (email: string, role?: string) => ({ email, app_metadata: role ? { role } : {}, user_metadata: {} }) as never
  it("Jodi is an owner but NOT the protected admin", () => {
    expect(isOwnerOnly(u("jodi@tonydurante.us"))).toBe(true)
    expect(isOwnerOnly(u("Jodi@TonyDurante.us"))).toBe(true)
    expect(isProtectedAdminEmail("jodi@tonydurante.us")).toBe(false)
    expect(isSecureAdmin(u("jodi@tonydurante.us"))).toBe(false)
    expect(isSecureAdmin(u("jodi@tonydurante.us", "admin"))).toBe(true)
  })
  it("Antonio is both, and the primary owner; staff are neither", () => {
    expect(isOwnerOnly(u("antonio.durante@tonydurante.us"))).toBe(true)
    expect(isProtectedAdminEmail("antonio.durante@tonydurante.us")).toBe(true)
    expect(PRIMARY_OWNER_EMAIL).toBe("antonio.durante@tonydurante.us")
    expect(isOwnerOnly(u("luca@tonydurante.us", "team"))).toBe(false)
    expect(isOwnerOnly(u("support@tonydurante.us", "team"))).toBe(false)
  })
})

import { rememberable } from "@/lib/crm-store/trash"
describe("rememberable (what a delete keeps for a restore)", () => {
  it("keeps links / type / category; never the scanned text, the stage or the visibility", () => {
    const r = rememberable({ drive_file_id: "store:x", account_id: "a", contact_id: "c", category: 3, ocr_text: "passport 123", ocr_confidence: 0.9, flow_stage: "EIN Received", portal_visible: true, client_notified_at: "t" })
    expect(r).toEqual({ drive_file_id: "store:x", account_id: "a", contact_id: "c", category: 3 })
  })
})

import { pathOf, draggedFolderPath } from "@/lib/crm-store/extras"
describe("paths for filters and dragged folders", () => {
  it("pathOf leaves out the storage's top folder", () => {
    const m = new Map([["r", { name: "Acme", parent_id: null }], ["t", { name: "3. Tax", parent_id: "r" }], ["y", { name: "2025", parent_id: "t" }]])
    expect(pathOf("y", m)).toBe("3. Tax › 2025")
    expect(pathOf("r", m)).toBe("")
  })
  it("draggedFolderPath drops the file name and empty parts", () => {
    expect(draggedFolderPath("Taxes/2024/w2.pdf")).toEqual(["Taxes", "2024"])
    expect(draggedFolderPath("w2.pdf")).toEqual([])
  })
})
