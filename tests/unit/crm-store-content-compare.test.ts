import { describe, it, expect } from "vitest"
import { compareTexts, tokenize } from "@/lib/crm-store/content-compare"

const LEASE = "RENT OFFICE AGREEMENT 1 of 4 ---PAGE BREAK--- This Virtual Office Agreement is effective as of 03/10/2024 between Tony Durante LLC (Landlord) and DIECI DIECI COMPANY LLC (Tenant). Rent is $150.00 per month. Title:Owner Tenant By: (Signature) Mario Cerbone"

// Accuracy set: pairs where the right answer is known. A false "identical" would let a real difference be deleted.
describe("word-by-word comparison — accuracy set", () => {
  it("a text against itself is identical", () => {
    expect(compareTexts(LEASE, LEASE).identical).toBe(true)
  })
  it("the same words with different spacing, line breaks, page markers, quotes and dashes are identical", () => {
    const b = LEASE.replace(/ /g, "  \n ").replace("---PAGE BREAK---", "--- page break ---").replace("Tony", "Tony​").replace("(Landlord)", "(Landlord)")
    expect(compareTexts(LEASE, b).identical).toBe(true)
    expect(compareTexts("it’s a “deal” – done", `it's a "deal" - done`).identical).toBe(true)
  })
  it("one changed word is different and is named", () => {
    const r = compareTexts(LEASE, LEASE.replace("Landlord", "Lessor"))
    expect(r.identical).toBe(false)
    expect(r.differences).toEqual([{ at: expect.any(Number), onlyInA: ["(Landlord)"], onlyInB: ["(Lessor)"] }])
  })
  it("one changed digit or date is different", () => {
    expect(compareTexts(LEASE, LEASE.replace("03/10/2024", "03/11/2024")).identical).toBe(false)
    expect(compareTexts(LEASE, LEASE.replace("$150.00", "$160.00")).identical).toBe(false)
  })
  it("a case change is different", () => {
    expect(compareTexts(LEASE, LEASE.replace("(Landlord)", "(LANDLORD)")).identical).toBe(false)
  })
  it("an added sentence or a removed word is different", () => {
    expect(compareTexts(LEASE, LEASE + " Signed.").identical).toBe(false)
    expect(compareTexts(LEASE, LEASE.replace("Virtual ", "")).identical).toBe(false)
  })
  it("the same words in another order are different", () => {
    expect(compareTexts("alpha beta gamma", "alpha gamma beta").identical).toBe(false)
  })
  it("empty against empty is identical; empty against text is not", () => {
    expect(compareTexts("", "  \n ").identical).toBe(true)
    expect(compareTexts("", "word").identical).toBe(false)
  })
  it("the real Dieci Dieci leases: two extra signature-mark words are reported, not ignored", () => {
    const signed = LEASE.replace("Title:Owner", "ΑΣ Α2 Title:Owner")
    const r = compareTexts(signed, LEASE)
    expect(r.identical).toBe(false)
    expect(r.wordsA - r.wordsB).toBe(2)
    expect(r.differences).toEqual([{ at: expect.any(Number), onlyInA: ["ΑΣ", "Α2"], onlyInB: [] }])
  })
  it("two unrelated documents are not itemised", () => {
    const words = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(" ")
    const r = compareTexts(words("a", 4000), words("b", 4000))
    expect(r.identical).toBe(false)
    expect(r.tooDifferentToList).toBe(true)
  })
  it("tokenize drops only invisible differences", () => {
    expect(tokenize("A B\tC\nD")).toEqual(["A", "B", "C", "D"])
    expect(tokenize("Ab aB")).toEqual(["Ab", "aB"])
  })
})
