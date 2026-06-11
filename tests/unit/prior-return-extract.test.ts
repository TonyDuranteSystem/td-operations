import { describe, it, expect } from "vitest"
import {
  parseExtraction,
  validatePriorReturn,
  relevantSections,
  type PriorReturnExtraction,
} from "@/lib/tax/prior-return-extract"

/** A coherent 1065 return: assets = liabilities + capital, M-2 ties, K-1s sum. */
function valid1065(): PriorReturnExtraction {
  return {
    form_type: "1065",
    tax_year: 2024,
    ein: "12-3456789",
    schedule_l: {
      beginning: { cash: 10_000, total_assets: 10_000, total_liabilities: 0, capital: 10_000 },
      ending: { cash: 45_250.5, total_assets: 45_250.5, total_liabilities: 5_000, capital: 40_250.5 },
    },
    m2: { beginning_capital: 10_000, ending_capital: 40_250.5 },
    k1s: [
      { partner_name: "Sofia Rossi", ownership_pct: 60, ending_capital: 24_150.3 },
      { partner_name: "Marco Bianchi", ownership_pct: 40, ending_capital: 16_100.2 },
    ],
  }
}

const EXPECT = { priorYear: 2024, ein: "12-3456789" }

describe("validatePriorReturn", () => {
  it("passes a coherent 1065", () => {
    expect(validatePriorReturn(valid1065(), EXPECT)).toEqual([])
  })

  it("flags the wrong tax year", () => {
    const x = valid1065(); x.tax_year = 2023
    expect(validatePriorReturn(x, EXPECT).map(i => i.code)).toContain("WRONG_YEAR")
  })

  it("flags an EIN that belongs to a different company (formats normalized)", () => {
    const x = valid1065(); x.ein = "98-7654321"
    expect(validatePriorReturn(x, EXPECT).map(i => i.code)).toContain("EIN_MISMATCH")
    // same digits, different formatting → no issue
    const y = valid1065(); y.ein = "123456789"
    expect(validatePriorReturn(y, EXPECT)).toEqual([])
  })

  it("flags a missing/blank Schedule L and stops there", () => {
    const x = valid1065(); x.schedule_l = null
    const issues = validatePriorReturn(x, EXPECT)
    expect(issues.map(i => i.code)).toEqual(["NO_SCHEDULE_L"])
  })

  it("flags an unbalanced Schedule L column", () => {
    const x = valid1065(); x.schedule_l!.ending.total_assets = 99_999
    expect(validatePriorReturn(x, EXPECT).map(i => i.code)).toContain("SCHEDULE_L_UNBALANCED")
  })

  it("flags M-2 ending capital that does not tie to Schedule L", () => {
    const x = valid1065(); x.m2 = { beginning_capital: 10_000, ending_capital: 12_345 }
    expect(validatePriorReturn(x, EXPECT).map(i => i.code)).toContain("M2_MISMATCH")
  })

  it("flags K-1s that do not sum to total capital, and percentages that do not sum to 100", () => {
    const x = valid1065()
    x.k1s[0].ending_capital = 1_000
    x.k1s[0].ownership_pct = 10
    const codes = validatePriorReturn(x, EXPECT).map(i => i.code)
    expect(codes).toContain("K1_SUM_MISMATCH")
    expect(codes).toContain("K1_PCT_SUM")
  })

  it("tolerates $2 rounding and 0.5% on percentages", () => {
    const x = valid1065()
    x.schedule_l!.ending.total_assets = 45_252 // +1.5 vs liabilities+capital
    x.k1s[0].ownership_pct = 60.3 // sum 100.3
    expect(validatePriorReturn(x, EXPECT)).toEqual([])
  })

  it("skips identities whose inputs are null instead of failing them", () => {
    const x = valid1065()
    x.schedule_l!.ending.total_liabilities = null
    x.k1s[1].ending_capital = null
    x.k1s[1].ownership_pct = null
    expect(validatePriorReturn(x, EXPECT)).toEqual([])
  })

  it("an 1120 needs no M-2 / K-1 identities", () => {
    const x: PriorReturnExtraction = {
      form_type: "1120", tax_year: 2024, ein: "12-3456789",
      schedule_l: {
        beginning: { cash: 0, total_assets: 0, total_liabilities: 0, capital: 0 },
        ending: { cash: 8_000, total_assets: 8_000, total_liabilities: 3_000, capital: 5_000 },
      },
      m2: null, k1s: [],
    }
    expect(validatePriorReturn(x, EXPECT)).toEqual([])
  })

  it("quarantines an unidentifiable form", () => {
    const x = valid1065(); x.form_type = "other"
    expect(validatePriorReturn(x, EXPECT).map(i => i.code)).toContain("UNSUPPORTED_FORM")
  })
})

describe("parseExtraction", () => {
  it("coerces a valid payload and drops junk K-1 entries", () => {
    const out = parseExtraction({
      form_type: "1065", tax_year: 2024, ein: " 12-3456789 ",
      schedule_l: { beginning: { cash: 1 }, ending: { cash: 2, total_assets: "nope" } },
      m2: { beginning_capital: 1, ending_capital: 2 },
      k1s: [{ partner_name: "A", ownership_pct: 50 }, { partner_name: "  " }, null, { ownership_pct: 50 }],
    })
    expect(out).not.toBeNull()
    expect(out!.ein).toBe("12-3456789")
    expect(out!.schedule_l!.ending.cash).toBe(2)
    expect(out!.schedule_l!.ending.total_assets).toBeNull()
    expect(out!.k1s).toHaveLength(1)
  })

  it("survives garbage", () => {
    expect(parseExtraction(null)).toBeNull()
    expect(parseExtraction("x")).toBeNull()
    const out = parseExtraction({ form_type: "weird", k1s: "no" })
    expect(out!.form_type).toBe("other")
    expect(out!.k1s).toEqual([])
  })
})

describe("relevantSections", () => {
  it("returns short text untouched", () => {
    expect(relevantSections("short")).toBe("short")
  })

  it("keeps page 1 + located headings from a long document", () => {
    const filler = "x".repeat(80_000)
    const text = `Form 1065 2024 EIN 12-3456789 ${"y".repeat(7000)}${filler}Balance Sheets per Books CASH 123${"z".repeat(8000)}Schedule K-1 Partner Sofia${filler}`
    const out = relevantSections(text)
    expect(out.length).toBeLessThanOrEqual(60_000)
    expect(out).toContain("Form 1065 2024")
    expect(out).toContain("Balance Sheets per Books CASH 123")
    expect(out).toContain("Schedule K-1 Partner Sofia")
  })
})
