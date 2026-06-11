import { describe, it, expect } from "vitest"
import { firstYearCoherent } from "@/lib/tax/prior-return-case"

describe("firstYearCoherent (Case C cross-check, §13 A6)", () => {
  it("formed in the tax year → coherent", () => {
    expect(firstYearCoherent("2025-03-17", 2025)).toBe(true)
  })

  it("formed after the tax year start but claim says first year → still coherent (formed mid-year)", () => {
    expect(firstYearCoherent("2025-12-30", 2025)).toBe(true)
  })

  it("formed BEFORE the tax year → mismatch (prior returns may exist)", () => {
    expect(firstYearCoherent("2023-06-01", 2025)).toBe(false)
  })

  it("no formation date on file → null (cannot cross-check, recorded as such)", () => {
    expect(firstYearCoherent(null, 2025)).toBeNull()
  })

  it("garbage date → null, never throws", () => {
    expect(firstYearCoherent("not-a-date", 2025)).toBeNull()
  })
})
