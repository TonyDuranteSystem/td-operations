import { describe, it, expect } from "vitest"
import { parseAuthoredAmount, authoredAmountValue } from "@/lib/offers/parse-authored-amount"
import { parsePriceQuirk } from "@/lib/offers/compute-offer-totals"

describe("parseAuthoredAmount", () => {
  it("parses a plain integer", () => {
    expect(parseAuthoredAmount("1750")).toEqual({ kind: "ok", amount: 1750 })
  })

  it("parses comma-grouped thousands", () => {
    expect(parseAuthoredAmount("1,750")).toEqual({ kind: "ok", amount: 1750 })
    expect(parseAuthoredAmount("1,750.50")).toEqual({ kind: "ok", amount: 1750.5 })
  })

  it("parses multi-group dot thousands unambiguously", () => {
    expect(parseAuthoredAmount("1.234.567")).toEqual({ kind: "ok", amount: 1234567 })
  })

  it("parses continental decimals", () => {
    expect(parseAuthoredAmount("1.234,56")).toEqual({ kind: "ok", amount: 1234.56 })
    expect(parseAuthoredAmount("1750,50")).toEqual({ kind: "ok", amount: 1750.5 })
  })

  it("parses an English decimal", () => {
    expect(parseAuthoredAmount("1750.50")).toEqual({ kind: "ok", amount: 1750.5 })
  })

  it("strips currency symbols and spaces", () => {
    expect(parseAuthoredAmount(" € 1750 ")).toEqual({ kind: "ok", amount: 1750 })
  })

  it("reports empty rather than zero", () => {
    expect(parseAuthoredAmount("")).toEqual({ kind: "empty" })
    expect(parseAuthoredAmount(null)).toEqual({ kind: "empty" })
    expect(parseAuthoredAmount("   ")).toEqual({ kind: "empty" })
  })

  it("rejects non-numeric and non-positive input", () => {
    expect(parseAuthoredAmount("abc").kind).toBe("invalid")
    expect(parseAuthoredAmount("0").kind).toBe("invalid")
  })

  // ─── THE REGRESSION THIS MODULE EXISTS FOR ───
  it("REFUSES TO GUESS the ambiguous dot-thousands form, and reports both readings", () => {
    const r = parseAuthoredAmount("1.750")
    expect(r).toEqual({ kind: "ambiguous", raw: "1.750", asThousands: 1750, asDecimal: 1.75 })
  })

  it("pins the exact bug: the stored-price parser silently returns 1.75 where this one refuses", () => {
    // parsePriceQuirk's behaviour is DELIBERATE for stored offer prices and must not change —
    // this test documents WHY it cannot be reused for a field a human is typing into.
    expect(parsePriceQuirk("1.750")).toBe(1.75)
    expect(parseAuthoredAmount("1.750").kind).toBe("ambiguous")
  })

  it("treats every non-ok reading as unusable, so a plan built from it cannot validate", () => {
    expect(authoredAmountValue(parseAuthoredAmount("1.750"))).toBe(0)
    expect(authoredAmountValue(parseAuthoredAmount(""))).toBe(0)
    expect(authoredAmountValue(parseAuthoredAmount("abc"))).toBe(0)
    expect(authoredAmountValue(parseAuthoredAmount("1750"))).toBe(1750)
  })
})
