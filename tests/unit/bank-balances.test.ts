/**
 * Unit tests for lib/tax/bank-balances.ts (S2 slice 2) — the per-bank balance
 * anchor merge + tie-out core. Pins the tri-role conditions:
 *  - system-derived (statement balance columns) OUTRANKS typed balances
 *  - a derived-vs-provided disagreement is a FINDING, never a silent pick
 *  - balances live in the account currency; conversion via the IRS table;
 *    a missing rate excludes the figure and flags it
 *  - total opening only when EVERY bank has one; source 'provided' when any
 *    typed balance fills a gap
 *  - tie-out: opening + net movement vs closing, tolerance-bounded
 */

import { describe, it, expect } from "vitest"
import { mergeBankBalances } from "@/lib/tax/bank-balances"

const bank = (over: Partial<{ bank_key: string; derived_beginning: number | null; reported_ending: number | null; net_movement: number }>) => ({
  bank_key: "Mercury Checking",
  derived_beginning: null,
  reported_ending: null,
  net_movement: 100,
  ...over,
})

describe("mergeBankBalances", () => {
  it("provided balances fill gaps and drive the tie-out", () => {
    const r = mergeBankBalances({
      banks: [bank({ net_movement: 101_437.73 })],
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 1_674.67, closing_balance: 103_112.40, source: "client" }],
      fxRates: null,
    })
    const m = r.banks[0]
    expect(m.opening_usd).toBeCloseTo(1_674.67, 2)
    expect(m.opening_source).toBe("client")
    expect(m.tie).toBe("ok")
    expect(r.total_opening_usd).toBeCloseTo(1_674.67, 2)
    expect(r.total_opening_source).toBe("provided")
  })

  it("names the bank and the hole on a mismatch", () => {
    const r = mergeBankBalances({
      banks: [bank({ net_movement: 98_377.74 })], // $3,060 short (the Dynamiq case)
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 1_674.67, closing_balance: 103_112.40, source: "client" }],
      fxRates: null,
    })
    expect(r.banks[0].tie).toBe("mismatch")
    expect(r.banks[0].delta_usd).toBeCloseTo(-3_059.99, 2)
    expect(r.mismatched_banks).toEqual(["Mercury Checking"])
  })

  it("system-derived outranks provided; a disagreement is a finding", () => {
    const r = mergeBankBalances({
      banks: [bank({ derived_beginning: 500, reported_ending: 600, net_movement: 100 })],
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 999, closing_balance: 600, source: "client" }],
      fxRates: null,
    })
    const m = r.banks[0]
    expect(m.opening_usd).toBe(500)
    expect(m.opening_source).toBe("statements")
    expect(m.provided_conflicts_derived).toBe(true)
    expect(m.tie).toBe("ok") // 500 + 100 = 600
    expect(r.total_opening_source).toBe("statements")
  })

  it("converts provided balances via the IRS rate; missing rate excludes + flags", () => {
    const withRate = mergeBankBalances({
      banks: [bank({ bank_key: "Wise EUR", net_movement: 0 })],
      provided: [{ bank_key: "Wise EUR", currency: "EUR", opening_balance: 924, closing_balance: 924, source: "client" }],
      fxRates: { EUR: 0.924 },
    })
    expect(withRate.banks[0].opening_usd).toBeCloseTo(1000, 2)
    expect(withRate.banks[0].tie).toBe("ok")

    const noRate = mergeBankBalances({
      banks: [bank({ bank_key: "Wise CHF", net_movement: 0 })],
      provided: [{ bank_key: "Wise CHF", currency: "CHF", opening_balance: 100, closing_balance: 100, source: "client" }],
      fxRates: { EUR: 0.924 },
    })
    expect(noRate.banks[0].opening_usd).toBeNull()
    expect(noRate.banks[0].missing_fx_rate).toBe(true)
    expect(noRate.total_opening_usd).toBeNull()
  })

  it("total opening requires EVERY bank covered; missing banks are named", () => {
    const r = mergeBankBalances({
      banks: [
        bank({ bank_key: "Mercury Checking" }),
        bank({ bank_key: "Relay Checking" }),
      ],
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 10, closing_balance: null, source: "client" }],
      fxRates: null,
    })
    expect(r.total_opening_usd).toBeNull()
    expect(r.missing_openings).toEqual(["Relay Checking"])
  })

  it("unverifiable when no closing anchor exists; tolerance bounds the tie", () => {
    const noClosing = mergeBankBalances({
      banks: [bank({})],
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 10, closing_balance: null, source: "staff" }],
      fxRates: null,
    })
    expect(noClosing.banks[0].tie).toBe("unverifiable")

    const withinTol = mergeBankBalances({
      banks: [bank({ net_movement: 100.01 })],
      provided: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 0, closing_balance: 100, source: "client" }],
      fxRates: null,
    })
    expect(withinTol.banks[0].tie).toBe("ok") // |0.01| <= 0.02
  })
})
