/**
 * Wizard bank-number gate (identity build 2026-08-13, card 4a39e0fd).
 * The submit-time, bypass-proof enforcement: banks need their number, services
 * don't ask, the escape waives, and prior numberless rows are grandfathered so
 * the 13 production re-editors are never stranded.
 */
import { describe, it, expect } from "vitest"
import { checkWizardBankNumbers, bankGateMessage } from "@/lib/tax/wizard-bank-gate"

const row = (i: number, bank: string, extra: Record<string, unknown> = {}) => ({
  [`bank_accounts_${i}_bank_name`]: bank,
  ...extra,
})

describe("checkWizardBankNumbers", () => {
  it("refuses a bank row with no number (the Chase shape) and names it canonically", () => {
    const r = checkWizardBankNumbers({ data: { bank_accounts_count: 1, ...row(0, "chase") } })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([{ index: 0, bank: "chase", canonical: "Chase", grandfathered: false }])
  })

  it("a typo'd unknown bank ('cahse') defaults to account_number mode — refused, not silently accepted", () => {
    const r = checkWizardBankNumbers({ data: { bank_accounts_count: 1, ...row(0, "cahse") } })
    expect(r.ok).toBe(false)
    expect(r.missing[0].canonical).toBe("cahse")
  })

  it("currency and crypto institutions never ask", () => {
    const r = checkWizardBankNumbers({
      data: { bank_accounts_count: 2, ...row(0, "Wise"), ...row(1, "Kraken") },
    })
    expect(r.ok).toBe(true)
    expect(r.missing).toHaveLength(0)
  })

  it("a provided number passes; the per-row escape waives", () => {
    const r = checkWizardBankNumbers({
      data: {
        bank_accounts_count: 2,
        ...row(0, "Chase", { bank_accounts_0_account_label: "1234" }),
        ...row(1, "SomeLocalBank", { bank_accounts_1_no_number: "1" }),
      },
    })
    expect(r.ok).toBe(true)
  })

  it("GRANDFATHER: a numberless bank identical to the prior submission passes with a flag, never a wall", () => {
    const prior = { bank_accounts_count: 1, ...row(0, "Chase") }
    const r = checkWizardBankNumbers({ data: { bank_accounts_count: 1, ...row(0, "Chase") }, priorData: prior })
    expect(r.ok).toBe(true)
    expect(r.grandfathered).toEqual([{ index: 0, bank: "Chase", canonical: "Chase", grandfathered: true }])
  })

  it("grandfather does NOT cover a renamed or new bank", () => {
    const prior = { bank_accounts_count: 1, ...row(0, "Chase") }
    const r = checkWizardBankNumbers({
      data: { bank_accounts_count: 2, ...row(0, "Chase"), ...row(1, "Mercury") },
      priorData: prior,
    })
    expect(r.ok).toBe(false)
    expect(r.missing.map(m => m.canonical)).toEqual(["Mercury"]) // Chase grandfathered, Mercury refused
  })

  it("grandfather is a BUDGET, not a blanket: one prior numberless Chase covers ONE current row — a second Chase account is refused (never silently merged)", () => {
    const prior = { bank_accounts_count: 1, ...row(0, "Chase") }
    const r = checkWizardBankNumbers({
      data: { bank_accounts_count: 2, ...row(0, "Chase"), ...row(1, "Chase") },
      priorData: prior,
    })
    expect(r.ok).toBe(false)
    expect(r.grandfathered).toHaveLength(1)
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].canonical).toBe("Chase")
  })

  it("grandfather does not apply when the prior row HAD a number (a regression, not a legacy state)", () => {
    const prior = { bank_accounts_count: 1, ...row(0, "Chase", { bank_accounts_0_account_label: "9999" }) }
    const r = checkWizardBankNumbers({ data: { bank_accounts_count: 1, ...row(0, "Chase") }, priorData: prior })
    expect(r.ok).toBe(false)
  })

  it("empty declarations and zero-count pass trivially", () => {
    expect(checkWizardBankNumbers({ data: {} }).ok).toBe(true)
    expect(checkWizardBankNumbers({ data: { bank_accounts_count: 2 } }).ok).toBe(true)
  })

  it("a catalog-injected registry drives the mode (reclassify without a deploy)", () => {
    const registry = [{ canonical: "Chase", mode: "currency" as const, matchTerms: ["chase"] }]
    const r = checkWizardBankNumbers({ data: { bank_accounts_count: 1, ...row(0, "Chase") }, registry })
    expect(r.ok).toBe(true) // reclassified to currency → no number asked
  })
})

describe("bankGateMessage", () => {
  it("names every refused bank and the fix, in both languages", () => {
    const m = bankGateMessage([
      { index: 0, bank: "chase", canonical: "Chase", grandfathered: false },
      { index: 2, bank: "relay", canonical: "Relay", grandfathered: false },
    ])
    expect(m.en).toContain("Chase, Relay")
    expect(m.en).toContain("last 4 digits")
    expect(m.it).toContain("Chase, Relay")
    expect(m.it).toContain("ultime 4 cifre")
  })
})
