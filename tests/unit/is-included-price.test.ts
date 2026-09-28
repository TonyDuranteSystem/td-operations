import { describe, it, expect } from "vitest"
import { isIncludedPrice } from "@/lib/offers/compute-offer-totals"

describe("isIncludedPrice (S1 2026-09-27)", () => {
  it("words meaning included", () => {
    for (const p of ["Included", "Inclusa", "incluso", "INCLUDED in the package"]) expect(isIncludedPrice(p)).toBe(true)
  })
  it("a real zero", () => {
    for (const p of ["$0", "€0", "€ 0,00", "0", "USD 0.00"]) expect(isIncludedPrice(p)).toBe(true)
  })
  it("REGRESSION: a real price that merely contains a 0 is NOT included (the old check said yes)", () => {
    for (const p of ["$1,000", "€1000", "$1200", "€350", "$900", "€ 250", "EUR 2,500"]) expect(isIncludedPrice(p)).toBe(false)
  })
  it("empty / missing price is not 'included'", () => {
    for (const p of ["", "   ", null, undefined]) expect(isIncludedPrice(p)).toBe(false)
  })
})
