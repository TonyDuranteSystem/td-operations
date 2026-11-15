import { describe, it, expect } from "vitest"
import {
  boxKeyFromLabel,
  cleanExtra,
  lookupKeys,
  MAX_BOXES_PER_TYPE,
  normalizeEmail,
  parseTypeMeta,
  personInputSchema,
  phoneKey,
  uniqueBoxKey,
  type Box,
} from "@/lib/address-book/types"

const BOXES: Box[] = [
  { key: "what_they_supply_us", label: "What they supply us", kind: "text" },
  { key: "contract_renewal", label: "Contract renewal", kind: "date" },
  { key: "monthly_cost", label: "Monthly cost", kind: "number" },
  { key: "preferred", label: "Preferred", kind: "yesno" },
]

describe("parseTypeMeta", () => {
  it("reads boxes, colour and order", () => {
    const m = parseTypeMeta({ boxes: [BOXES[0], BOXES[1]], color: "orange", sort_order: 20 })
    expect(m.boxes).toHaveLength(2)
    expect(m.color).toBe("orange")
    expect(m.sort_order).toBe(20)
  })
  it("never throws on rubbish and gives an empty type", () => {
    for (const bad of [null, undefined, "x", 5, [], { boxes: "no" }, { boxes: [null, 3, "a"] }]) {
      expect(parseTypeMeta(bad).boxes).toEqual([])
    }
    expect(parseTypeMeta({}).color).toBeNull()
    expect(parseTypeMeta({}).sort_order).toBe(0)
  })
  it("drops a bad box, keeps the first of a repeated key, and cuts at the limit", () => {
    const m = parseTypeMeta({
      boxes: [
        { key: "Bad Key", label: "x", kind: "text" },
        { key: "a", label: "A", kind: "text" },
        { key: "a", label: "A again", kind: "date" },
        { key: "b", label: "B", kind: "weird" },
        { key: "c", label: "", kind: "text" },
      ],
    })
    expect(m.boxes.map((b) => b.key)).toEqual(["a"])
    expect(m.boxes[0].label).toBe("A")
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, kind: "text" }))
    expect(parseTypeMeta({ boxes: many }).boxes).toHaveLength(MAX_BOXES_PER_TYPE)
  })
})

describe("box keys", () => {
  it("turns a label into a stable key", () => {
    expect(boxKeyFromLabel("What they supply us")).toBe("what_they_supply_us")
    expect(boxKeyFromLabel("  Número di conto! ")).toBe("numero_di_conto")
    expect(boxKeyFromLabel("2nd contact")).toBe("box_2nd_contact")
    expect(boxKeyFromLabel("???")).toBe("box")
  })
  it("always produces a valid key, whatever the label", () => {
    for (const l of ["a", "A very long label ".repeat(10), "日本語", "x-y/z", "   "]) {
      expect(boxKeyFromLabel(l)).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
    }
  })
  it("a new box never reuses a key", () => {
    expect(uniqueBoxKey("Cost", [])).toBe("cost")
    expect(uniqueBoxKey("Cost", ["cost"])).toBe("cost_2")
    expect(uniqueBoxKey("Cost", ["cost", "cost_2"])).toBe("cost_3")
  })
})

describe("cleanExtra", () => {
  it("keeps good values of every kind", () => {
    const r = cleanExtra(BOXES, { what_they_supply_us: "  Printing ", contract_renewal: "2027-03-01", monthly_cost: "1200,50", preferred: "yes" })
    expect(r.problems).toEqual([])
    expect(r.value).toEqual({ what_they_supply_us: "Printing", contract_renewal: "2027-03-01", monthly_cost: 1200.5, preferred: true })
  })
  it("drops boxes the type does not have and empty values", () => {
    const r = cleanExtra(BOXES, { what_they_supply_us: "", contract_renewal: null, made_up: "x" })
    expect(r.value).toEqual({})
    expect(r.problems).toEqual([])
  })
  it("reports a value of the wrong kind and does not save it", () => {
    const r = cleanExtra(BOXES, { contract_renewal: "next spring", monthly_cost: "lots", preferred: "maybe" })
    expect(r.value).toEqual({})
    expect(r.problems).toEqual(["Contract renewal must be a date", "Monthly cost must be a number", "Preferred must be yes or no"])
  })
  it("rejects a date that does not exist", () => {
    expect(cleanExtra(BOXES, { contract_renewal: "2027-02-31" }).problems).toHaveLength(1)
    expect(cleanExtra(BOXES, { contract_renewal: "2028-02-29" }).problems).toHaveLength(0)
  })
  it("accepts true/false booleans and survives non-object input", () => {
    expect(cleanExtra(BOXES, { preferred: false }).value).toEqual({ preferred: false })
    expect(cleanExtra(BOXES, null).value).toEqual({})
    expect(cleanExtra([], { a: 1 }).value).toEqual({})
  })
})

describe("phone and email keys", () => {
  it("phoneKey is digits only and ignores too-short numbers", () => {
    expect(phoneKey("+1 (555) 010-0188")).toBe("15550100188")
    expect(phoneKey("555 0100")).toBe("5550100")
    expect(phoneKey("123")).toBeNull()
    expect(phoneKey(null)).toBeNull()
  })
  it("normalizeEmail lower-cases and refuses non-emails", () => {
    expect(normalizeEmail("  Tom@Lakeshore.Example ")).toBe("tom@lakeshore.example")
    expect(normalizeEmail("not an email")).toBeNull()
    expect(normalizeEmail("")).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
  })
  it("lookupKeys cleans, de-duplicates and keeps the typed phones", () => {
    const k = lookupKeys({ phones: ["+1 (555) 010-0188", "1-555-010-0188", " ", "12"], emails: ["A@B.co", "a@b.co", "bad"] })
    expect(k.phones).toEqual(["+1 (555) 010-0188", "1-555-010-0188", "12"])
    expect(k.phone_keys).toEqual(["15550100188"])
    expect(k.emails).toEqual(["a@b.co"])
    expect(lookupKeys({})).toEqual({ phones: [], phone_keys: [], emails: [] })
  })
})

describe("personInputSchema", () => {
  it("needs a name, fills the rest with empty values", () => {
    const p = personInputSchema.parse({ full_name: "  Tom Whitfield " })
    expect(p.full_name).toBe("Tom Whitfield")
    expect(p.company).toBeNull()
    expect(p.phones).toEqual([])
    expect(personInputSchema.safeParse({ full_name: "  " }).success).toBe(false)
    expect(personInputSchema.safeParse({}).success).toBe(false)
  })
  it("limits how many phones and emails", () => {
    expect(personInputSchema.safeParse({ full_name: "A", phones: Array(7).fill("12345") }).success).toBe(false)
    expect(personInputSchema.safeParse({ full_name: "A", emails: Array(7).fill("a@b.co") }).success).toBe(false)
  })
})
