import { describe, it, expect, vi, beforeEach } from "vitest"

const calls: Array<{ method: string; args: unknown[] }> = []
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null }

// a chain that records every call and resolves to `result` when awaited
function chain() {
  const c: Record<string, unknown> = {}
  for (const m of ["select", "eq", "is", "or", "order", "range", "in"]) {
    c[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return c }
  }
  c.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return c
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(() => chain()), storage: { from: vi.fn() } } }))

import {
  pickKindFolder, topFolderIdsByKind, pickYearFolder, directChildrenOfKind, topFolder, isPlainKind, type LookupFolder,
} from "@/lib/crm-store/folder-lookup"
import { folderOfKind } from "@/lib/crm-store/formation-pilot"
import { compareLookups, legacyPickKindFolder, legacyPickYearFolder } from "../../scripts/crm-store/compare-folder-lookup"

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
const f = (id: string, parent_id: string | null, kind: string, name: string, created = 0): LookupFolder => ({ id, parent_id, kind, name, created_at: T(created) })

/** Today's standard company storage: root + the five fixed folders + tax years inside Tax. */
function standard(): LookupFolder[] {
  return [
    f("root", null, "root", "Acme LLC", 0),
    f("co", "root", "company", "1. Company", 1),
    f("ct", "root", "contacts", "2. Contacts", 2),
    f("tax", "root", "tax", "3. Tax", 3),
    f("bk", "root", "banking", "4. Banking", 4),
    f("cr", "root", "correspondence", "5. Correspondence", 5),
    f("y24", "tax", "tax_year", "2024", 6),
    f("y25", "tax", "tax_year", "2025", 7),
    f("cu", "co", "custom", "Misc", 8),
  ]
}

/** After a name change: the four fixed folders moved under Previous names › Old Name; a fresh set created under the root. The archive is OLDER. */
function afterNameChange(): LookupFolder[] {
  const s = standard()
  const moved = new Set(["co", "tax", "bk", "cr"])
  const rows = s.map((r) => (moved.has(r.id) ? { ...r, parent_id: "arch-old" } : r))
  rows.push(f("prev", "root", "custom", "Previous names", 100), f("arch-old", "prev", "custom", "Acme LLC", 101))
  rows.push(f("co2", "root", "company", "1. Company", 102), f("tax2", "root", "tax", "3. Tax", 103), f("bk2", "root", "banking", "4. Banking", 104), f("cr2", "root", "correspondence", "5. Correspondence", 105))
  return rows
}

const shuffles = <T,>(rows: T[]): T[][] => [rows, [...rows].reverse(), [...rows.slice(3), ...rows.slice(0, 3)]]

beforeEach(() => { calls.length = 0; result = { data: [], error: null } })

describe("folder lookup — today's single-kind storage answers exactly as before", () => {
  it("finds each fixed folder directly under the top folder", () => {
    const rows = standard()
    expect(pickKindFolder(rows, "company")).toBe("co")
    expect(pickKindFolder(rows, "contacts")).toBe("ct")
    expect(pickKindFolder(rows, "tax")).toBe("tax")
    expect(pickKindFolder(rows, "banking")).toBe("bk")
    expect(pickKindFolder(rows, "correspondence")).toBe("cr")
  })
  it("a kind the storage does not have is null (the caller throws, as before)", () => {
    expect(pickKindFolder(standard(), "itin")).toBeNull()
    expect(pickKindFolder([], "tax")).toBeNull()
    expect(pickKindFolder(standard().filter((r) => r.parent_id !== null), "tax")).toBeNull() // no top folder in the rows
  })
  it("the top folder answers for its own kind (Business / My files / Unfiled) unless told not to", () => {
    const rows = [f("b", null, "business_root", "Business"), f("c1", "b", "custom", "BofA")]
    expect(pickKindFolder(rows, "business_root")).toBe("b")
    expect(pickKindFolder(rows, "business_root", { includeRoot: false })).toBeNull()
  })
  it("a year folder is found by name inside the Tax folder, at any depth below it", () => {
    const rows = [...standard(), f("fed", "tax", "custom", "Federal", 9), f("y23", "fed", "tax_year", "2023", 10), f("y22", "tax", "tax_year", " 2022 ", 11)]
    expect(pickYearFolder(rows, "tax_year", 2025)).toBe("y25")
    expect(pickYearFolder(rows, "tax_year", 2023)).toBe("y23")
    expect(pickYearFolder(rows, "tax_year", 2022)).toBe("y22") // a folder name is compared trimmed, as before
    expect(pickYearFolder(rows, "tax_year", 2019)).toBeNull()
    expect(pickYearFolder(rows, "no_such_kind", 2025)).toBeNull()
  })
  it("a person's year folders live in the personal Tax folder", () => {
    const rows = [f("r", null, "root", "Mario"), f("pt", "r", "person_tax", "Tax"), f("py", "pt", "person_tax_year", "2025")]
    expect(pickYearFolder(rows, "person_tax_year", 2025)).toBe("py")
    expect(pickYearFolder(rows, "tax_year", 2025)).toBeNull()
  })
  it("topFolderIdsByKind holds only the top folder's direct children (no year folders, no custom ones)", () => {
    const m = topFolderIdsByKind(standard())
    expect(Array.from(m.entries()).sort()).toEqual([["banking", "bk"], ["company", "co"], ["contacts", "ct"], ["correspondence", "cr"], ["tax", "tax"]])
    expect(m.has("tax_year")).toBe(false)
  })
})

describe("folder lookup — a storage with two Tax folders (after a name change)", () => {
  it("every fixed kind resolves to the FRESH folder, whatever order the rows come in and although the archived one is older", () => {
    for (const rows of shuffles(afterNameChange())) {
      expect(pickKindFolder(rows, "tax")).toBe("tax2")
      expect(pickKindFolder(rows, "company")).toBe("co2")
      expect(pickKindFolder(rows, "banking")).toBe("bk2")
      expect(pickKindFolder(rows, "correspondence")).toBe("cr2")
      expect(pickKindFolder(rows, "contacts")).toBe("ct") // Contacts stays where it is
      expect(topFolderIdsByKind(rows).get("tax")).toBe("tax2")
    }
  })
  it("a year folder is looked for in the fresh Tax folder only — the archived 2025 is never an answer", () => {
    for (const rows of shuffles(afterNameChange())) {
      expect(pickYearFolder(rows, "tax_year", 2025)).toBeNull() // fresh Tax has no 2025 yet; the archived one (y25) must NOT be returned
    }
    const withFresh = [...afterNameChange(), f("y25b", "tax2", "tax_year", "2025", 200)]
    for (const rows of shuffles(withFresh)) expect(pickYearFolder(rows, "tax_year", 2025)).toBe("y25b")
  })
  it("the OLD rule could answer with the archived folder (this is what the fix prevents)", () => {
    const rows = afterNameChange()
    const picks = shuffles(rows).map((r) => legacyPickKindFolder(r, "tax"))
    expect(picks.some((id) => id === "tax")).toBe(true) // the archived Tax: wrong
    expect(legacyPickYearFolder(rows, "tax_year", 2025)).toBe("y25") // the archived 2025: wrong
  })
  it("two folders of the same kind side by side: the oldest wins, always", () => {
    const rows = [f("r", null, "root", "X"), f("t2", "r", "tax", "3. Tax (2)", 50), f("t1", "r", "tax", "3. Tax", 10)]
    for (const s of shuffles(rows)) expect(pickKindFolder(s, "tax")).toBe("t1")
    const sameTime = [f("r", null, "root", "X"), f("b", "r", "tax", "B", 5), f("a", "r", "tax", "A", 5)]
    for (const s of shuffles(sameTime)) expect(pickKindFolder(s, "tax")).toBe("a") // tie → smallest id
  })
  it("a kind that ONLY exists inside the archive is not an answer", () => {
    const rows = [f("r", null, "root", "X"), f("prev", "r", "custom", "Previous names"), f("old", "prev", "custom", "Old"), f("oldtax", "old", "tax", "3. Tax")]
    expect(pickKindFolder(rows, "tax")).toBeNull()
    expect(directChildrenOfKind(rows, "tax")).toEqual([])
    expect(topFolder(rows)?.id).toBe("r")
  })
})

describe("folder lookup — isPlainKind", () => {
  it("accepts a fixed kind, refuses anything that could break a database filter", () => {
    for (const k of ["tax", "tax_year", "person_tax_year", "business_root"]) expect(isPlainKind(k)).toBe(true)
    for (const k of ["", "Tax", "a,b", "kind.eq.x", "x)", "a b", "x".repeat(41)]) expect(isPlainKind(k)).toBe(false)
  })
})

describe("folderOfKind (database wrapper)", () => {
  it("reads the top folder plus the folders of that kind, and answers with the top folder's direct child", async () => {
    result = { data: [f("root", null, "root", "Acme"), f("tax-old", "arch", "tax", "3. Tax", 1), f("tax-new", "root", "tax", "3. Tax", 9)], error: null }
    expect(await folderOfKind("owner-1", "tax")).toBe("tax-new")
    expect(calls.find((c) => c.method === "or")?.args[0]).toBe("parent_id.is.null,kind.eq.tax")
    expect(calls.some((c) => c.method === "eq" && c.args[0] === "owner_id" && c.args[1] === "owner-1")).toBe(true)
    expect(calls.some((c) => c.method === "is" && c.args[0] === "trashed_at" && c.args[1] === null)).toBe(true)
  })
  it("keeps the message callers rely on when the folder is missing", async () => {
    result = { data: [f("root", null, "root", "Mario")], error: null }
    await expect(folderOfKind("o", "itin")).rejects.toThrow(/has no "itin" folder/)
  })
  it("a database error stops with the read error", async () => {
    result = { data: null, error: { message: "boom" } }
    await expect(folderOfKind("o", "tax")).rejects.toThrow(/could not read folders — boom/)
  })
  it("a kind that is not a plain word never reaches the database", async () => {
    await expect(folderOfKind("o", "a,parent_id.not.is.null")).rejects.toThrow(/has no/)
    expect(calls.length).toBe(0)
  })
})

describe("old-vs-new comparison (the all-owners proof)", () => {
  it("a standard storage: every lookup the code makes is identical", () => {
    const r = compareLookups([{ ownerId: "o1", rows: standard() }])
    expect(r.differences).toEqual([])
    expect(r.lookups).toBeGreaterThan(0)
    expect(r.identical).toBe(r.lookups)
  })
  it("a storage with two Tax folders is reported (ambiguous before, one clear answer now)", () => {
    const r = compareLookups([{ ownerId: "o2", rows: afterNameChange() }])
    expect(r.differences.length).toBeGreaterThan(0)
    expect(r.differences.some((d) => d.what === "kind:tax")).toBe(true)
    expect(r.differences.some((d) => d.what === "year:tax_year:2025")).toBe(true)
  })
  it("a year folder placed outside the Tax folder is reported", () => {
    const rows = [...standard(), f("stray", "co", "tax_year", "2022", 20)]
    const r = compareLookups([{ ownerId: "o3", rows }])
    expect(r.differences.some((d) => d.what === "year:tax_year:2022")).toBe(true)
  })
  it("two year folders with the same name are reported", () => {
    const rows = [...standard(), f("dup", "tax", "tax_year", "2025", 30)]
    const r = compareLookups([{ ownerId: "o4", rows }])
    expect(r.differences.some((d) => d.what === "year:tax_year:2025")).toBe(true)
  })
})
