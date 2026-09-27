import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { stateGroup, groupOwners, isLockedFolder, cleanFolderName, suggestTaxYear, CLOSED_STATUSES } from "@/lib/crm-store/structure"

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
