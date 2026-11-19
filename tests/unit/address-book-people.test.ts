import { describe, it, expect } from "vitest"
import { buildSearch, chipCounts, filterRows, firstOf, kindText, parseFilter, rowMatchesFilter, searchMatches, sortKey, type PersonRow, type TypeDto } from "@/lib/address-book/people"

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const types: TypeDto[] = [
  { id: T1, slug: "supplier", name: "Supplier", color: "orange", sortOrder: 10, boxes: [], hidden: false, savedCount: 1 },
  { id: T2, slug: "lawyer", name: "Lawyer", color: null, sortOrder: 20, boxes: [], hidden: true, savedCount: 0 },
]

function row(over: Partial<PersonRow>): PersonRow {
  return {
    key: "contact:x",
    source: "crm",
    id: "x",
    name: "Giulia Ferrante",
    company: "Ferrante Studio LLC",
    phone: "+1 (555) 010-0142",
    email: "giulia@example.com",
    crmKind: "company",
    typeId: null,
    serviceArea: null,
    extra: {},
    detail: null,
    search: buildSearch({ name: "Giulia Ferrante", company: "Ferrante Studio LLC", emails: ["giulia@example.com"], phones: ["+1 (555) 010-0142"] }),
    createdAt: null,
    ...over,
  }
}

const ROWS: PersonRow[] = [
  row({ key: "contact:1", id: "1" }),
  row({ key: "contact:2", id: "2", name: "Luca Moretti", company: null, crmKind: "unsorted", search: "luca moretti luca.m@example.com +39 555 010 871 39555010871" }),
  row({ key: "contact:3", id: "3", name: "Sofia Rossi", crmKind: "unsorted", typeId: T1, search: "sofia rossi" }),
  row({ key: "partner:4", id: "4", name: "Daniela Rossi", crmKind: "banker", search: "daniela rossi" }),
  row({ key: "saved:5", id: "5", source: "saved", name: "Tom Whitfield", crmKind: null, typeId: T1, search: "tom whitfield lakeshore" }),
  row({ key: "saved:6", id: "6", source: "saved", name: "Elena Costa", crmKind: null, typeId: null, search: "elena costa" }),
]

describe("filters", () => {
  it("everyone shows all", () => {
    expect(filterRows(ROWS, "all", "")).toHaveLength(6)
  })
  it("a CRM chip shows only CRM people the CRM puts there, never one Antonio already sorted", () => {
    expect(filterRows(ROWS, "crm:unsorted", "").map((r) => r.id)).toEqual(["2"])
    expect(filterRows(ROWS, "crm:company", "").map((r) => r.id)).toEqual(["1"])
    expect(filterRows(ROWS, "crm:banker", "").map((r) => r.id)).toEqual(["4"])
  })
  it("a type chip shows saved people of that type AND CRM people Antonio confirmed for it", () => {
    expect(filterRows(ROWS, `type:${T1}`, "").map((r) => r.id).sort()).toEqual(["3", "5"])
  })
  it("the no-type chip shows saved people without a type", () => {
    expect(filterRows(ROWS, "saved:none", "").map((r) => r.id)).toEqual(["6"])
    expect(rowMatchesFilter(ROWS[0], "saved:none")).toBe(false)
  })
})

describe("parseFilter", () => {
  it("accepts only filters that exist", () => {
    expect(parseFilter("crm:lead", types)).toBe("crm:lead")
    expect(parseFilter(`type:${T1}`, types)).toBe(`type:${T1}`)
    expect(parseFilter("saved:none", types)).toBe("saved:none")
    expect(parseFilter("crm:nonsense", types)).toBe("all")
    expect(parseFilter("type:33333333-3333-4333-8333-333333333333", types)).toBe("all")
    expect(parseFilter(null, types)).toBe("all")
    expect(parseFilter("", types)).toBe("all")
  })
})

describe("search", () => {
  it("matches name, company, email and phone, without case", () => {
    expect(searchMatches(ROWS[0], "FERRANTE")).toBe(true)
    expect(searchMatches(ROWS[0], "studio llc")).toBe(true)
    expect(searchMatches(ROWS[0], "giulia@example")).toBe(true)
    expect(searchMatches(ROWS[0], "zzz")).toBe(false)
  })
  it("every word must match", () => {
    expect(searchMatches(ROWS[0], "giulia studio")).toBe(true)
    expect(searchMatches(ROWS[0], "giulia nobody")).toBe(false)
  })
  it("finds a phone however it was typed", () => {
    expect(searchMatches(ROWS[0], "5550100142")).toBe(true)
    expect(searchMatches(ROWS[0], "555 999")).toBe(false)
    expect(searchMatches(ROWS[0], "555 010-0142")).toBe(true)
    expect(searchMatches(ROWS[0], "(555)")).toBe(true)
    expect(searchMatches(ROWS[1], "39555010871")).toBe(true)
  })
  it("an empty search matches everyone", () => {
    expect(searchMatches(ROWS[0], "   ")).toBe(true)
  })
  it("filter and search work together", () => {
    expect(filterRows(ROWS, `type:${T1}`, "tom").map((r) => r.id)).toEqual(["5"])
  })
})

describe("chip counts", () => {
  it("count each person once: under their type if they have one, otherwise under what the CRM says", () => {
    const c = chipCounts(ROWS)
    expect(c.all).toBe(6)
    expect(c.crm.company).toBe(1)
    expect(c.crm.unsorted).toBe(1) // Sofia is sorted by Antonio, so she is not counted as unsorted
    expect(c.crm.banker).toBe(1)
    expect(c.types[T1]).toBe(2)
    expect(c.savedNone).toBe(1)
  })
})

describe("small helpers", () => {
  it("kindText names the type, 'No type' for a saved person without one, or what the CRM says", () => {
    expect(kindText(ROWS[4], types)).toBe("Supplier")
    expect(kindText(ROWS[5], types)).toBe("No type")
    expect(kindText(ROWS[0], types)).toBe("Client with a company")
    expect(kindText(ROWS[3], types)).toBe("Banker")
  })
  it("firstOf skips empty values", () => {
    expect(firstOf([null, "  ", "a@b.co", "c@d.co"])).toBe("a@b.co")
    expect(firstOf([])).toBeNull()
  })
  it("buildSearch holds the digits of every phone", () => {
    expect(buildSearch({ name: "A", emails: ["X@Y.co"], phones: ["+1 (555) 010-0100"] })).toContain("15550100100")
    expect(buildSearch({ name: "A", emails: ["X@Y.co"], phones: [] })).toContain("x@y.co")
  })
  it("sortKey ignores accents and case and puts a missing name last", () => {
    expect(sortKey("Élodie")).toBe("elodie")
    expect(sortKey("  ")).toBe("￿")
  })
})
