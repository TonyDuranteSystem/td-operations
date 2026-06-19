import { describe, it, expect } from "vitest"
import { toUsd } from "@/lib/tax/fx"

const RATES = { EUR: 0.886, GBP: 0.795 } // foreign units per USD (IRS 2025)

describe("toUsd", () => {
  it("passes USD and empty/null currency through unchanged", () => {
    expect(toUsd(100, "USD", RATES)).toEqual({ usd: 100, missingRate: false })
    expect(toUsd(100, "", RATES)).toEqual({ usd: 100, missingRate: false })
    expect(toUsd(100, null, RATES)).toEqual({ usd: 100, missingRate: false })
    expect(toUsd(-50, "usd", RATES)).toEqual({ usd: -50, missingRate: false })
  })

  it("converts a foreign amount by dividing by the rate (IRS direction)", () => {
    // €100 at 0.886 EUR/USD = $112.87
    expect(toUsd(100, "EUR", RATES).usd).toBeCloseTo(112.8668, 3)
    expect(toUsd(100, "EUR", RATES).missingRate).toBe(false)
    // preserves sign for outflows
    expect(toUsd(-88.6, "EUR", RATES).usd).toBeCloseTo(-100, 6)
    // case-insensitive currency
    expect(toUsd(100, "eur", RATES).usd).toBeCloseTo(112.8668, 3)
  })

  it("flags a non-USD amount with no rate and leaves it unconverted (never silent 1:1)", () => {
    expect(toUsd(100, "AED", RATES)).toEqual({ usd: 100, missingRate: true })
  })

  it("treats a missing/zero/negative rate as missing, not a divide", () => {
    expect(toUsd(100, "EUR", { EUR: 0 })).toEqual({ usd: 100, missingRate: true })
    expect(toUsd(100, "EUR", { EUR: -1 })).toEqual({ usd: 100, missingRate: true })
  })
})
