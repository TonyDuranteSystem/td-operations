import { describe, it, expect } from "vitest"
import { cleanBoxes, cleanTypeName, normalizeTypeName, typeNameTaken, MAX_TYPE_NAME } from "@/lib/address-book/type-input"
import { cleanColor, TYPE_COLORS } from "@/lib/address-book/type-colors"
import { MAX_BOXES_PER_TYPE, type Box } from "@/lib/address-book/types"

describe("type names", () => {
  it("a name must exist and fit", () => {
    expect(cleanTypeName("  Fornitore   caro ")).toEqual({ name: "Fornitore caro" })
    expect(cleanTypeName("")).toHaveProperty("error")
    expect(cleanTypeName("   ")).toHaveProperty("error")
    expect(cleanTypeName(null)).toHaveProperty("error")
    expect(cleanTypeName(7)).toHaveProperty("error")
    expect(cleanTypeName("x".repeat(MAX_TYPE_NAME + 1))).toHaveProperty("error")
    expect(cleanTypeName("x".repeat(MAX_TYPE_NAME))).toEqual({ name: "x".repeat(MAX_TYPE_NAME) })
  })
  it("two names are the same when only case, accents or spacing differ", () => {
    expect(normalizeTypeName("  Fornitóre  ")).toBe("fornitore")
    expect(typeNameTaken("FORNITORE", [{ id: "a", name: "Fornitóre" }])).toBe(true)
    expect(typeNameTaken("Lawyer", [{ id: "a", name: "Supplier" }])).toBe(false)
  })
  it("a type is never in conflict with itself", () => {
    expect(typeNameTaken("Supplier", [{ id: "a", name: "Supplier" }], "a")).toBe(false)
    expect(typeNameTaken("Supplier", [{ id: "a", name: "Supplier" }, { id: "b", name: "supplier" }], "a")).toBe(true)
  })
})

describe("colours", () => {
  it("only the listed colours", () => {
    for (const c of TYPE_COLORS) expect(cleanColor(c)).toBe(c)
    expect(cleanColor(" Blue ")).toBe("blue")
    expect(cleanColor("chartreuse")).toBeNull()
    expect(cleanColor(null)).toBeNull()
    expect(cleanColor(5)).toBeNull()
  })
})

const EXISTING: Box[] = [
  { key: "what_they_supply_us", label: "What they supply us", kind: "text" },
  { key: "renewal", label: "Renewal", kind: "date" },
]

describe("the boxes of a type", () => {
  it("new boxes get a key made from the label", () => {
    const r = cleanBoxes([{ label: "Monthly cost", kind: "number" }, { label: "Preferred", kind: "yesno" }], [])
    expect(r).toEqual({ boxes: [{ key: "monthly_cost", label: "Monthly cost", kind: "number" }, { key: "preferred", label: "Preferred", kind: "yesno" }] })
  })
  it("an existing box keeps its key even when renamed, and the browser's idea of a new key is ignored", () => {
    const r = cleanBoxes([{ key: "what_they_supply_us", label: "What they sell us", kind: "text" }, { key: "hacked_key", label: "Brand new", kind: "text" }], EXISTING)
    expect(r).toEqual({ boxes: [{ key: "what_they_supply_us", label: "What they sell us", kind: "text" }, { key: "brand_new", label: "Brand new", kind: "text" }] })
  })
  it("the kind of an existing box cannot change (saved values would no longer fit)", () => {
    const r = cleanBoxes([{ key: "renewal", label: "Renewal", kind: "text" }], EXISTING)
    expect(r).toHaveProperty("error")
  })
  it("a new box never takes the key of a box that exists or was removed earlier", () => {
    const r = cleanBoxes([{ label: "Renewal", kind: "text" }], EXISTING, ["old_box"])
    expect(r).toEqual({ boxes: [{ key: "renewal_2", label: "Renewal", kind: "text" }] })
    const r2 = cleanBoxes([{ label: "Old box", kind: "text" }], [], ["old_box"])
    expect(r2).toEqual({ boxes: [{ key: "old_box_2", label: "Old box", kind: "text" }] })
  })
  it("refuses an empty name, an unknown kind, a repeated name and too many boxes", () => {
    expect(cleanBoxes([{ label: " ", kind: "text" }], [])).toHaveProperty("error")
    expect(cleanBoxes([{ label: "A", kind: "colour" }], [])).toHaveProperty("error")
    expect(cleanBoxes([{ label: "A", kind: "text" }, { label: "a ", kind: "date" }], [])).toHaveProperty("error")
    expect(cleanBoxes(Array.from({ length: MAX_BOXES_PER_TYPE + 1 }, (_, i) => ({ label: `B${i}`, kind: "text" })), [])).toHaveProperty("error")
    expect(cleanBoxes("nope", [])).toHaveProperty("error")
    expect(cleanBoxes([{ label: "x".repeat(61), kind: "text" }], [])).toHaveProperty("error")
  })
  it("no boxes is fine", () => {
    expect(cleanBoxes([], EXISTING)).toEqual({ boxes: [] })
  })
})
