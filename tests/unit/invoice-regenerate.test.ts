import { describe, it, expect } from "vitest"
import {
  buildRegeneratedLineItems,
  computeAppliedCredit,
  isCreditLine,
  sumLineAmounts,
  CREDIT_LINE_LABEL,
} from "@/lib/portal/invoice-regenerate"

const svc = (description: string, unit_price: number, quantity = 1) => ({
  description,
  quantity,
  unit_price,
  amount: unit_price * quantity,
})

describe("isCreditLine", () => {
  it("flags negative-amount lines", () => {
    expect(isCreditLine({ description: "anything", amount: -100 })).toBe(true)
  })
  it("flags our credit labels", () => {
    expect(isCreditLine({ description: "Credit applied", amount: 0 })).toBe(true)
    expect(isCreditLine({ description: "Service − credit ($200)", amount: 0 })).toBe(true)
  })
  it("does not flag a normal positive service line", () => {
    expect(isCreditLine({ description: "Installment 2 (Jun)", amount: 1000 })).toBe(false)
  })
})

describe("computeAppliedCredit", () => {
  it("uses the gross−due reduction when fully backed by a linked credit", () => {
    // DR Digital: gross 1000, due 750, linked CN 250 → 250
    expect(computeAppliedCredit({ gross: 1000, amountDue: 750, linkedCreditTotal: 250 })).toBe(250)
  })
  it("caps at the linked credit total (never invents credit from a real payment)", () => {
    // gross−due = 350 but only 250 of credit is linked → 250 (the extra 100 is a real payment)
    expect(computeAppliedCredit({ gross: 1000, amountDue: 650, linkedCreditTotal: 250 })).toBe(250)
  })
  it("caps at the partial amount applied here (Carasso split: 344 of a 380 credit)", () => {
    expect(computeAppliedCredit({ gross: 1000, amountDue: 656, linkedCreditTotal: 380 })).toBe(344)
  })
  it("returns 0 when no reduction (Wise June draft: still full)", () => {
    expect(computeAppliedCredit({ gross: 1000, amountDue: 1000, linkedCreditTotal: 0 })).toBe(0)
  })
  it("returns 0 when no linked credit even if due < gross (reduction was a real payment)", () => {
    expect(computeAppliedCredit({ gross: 1000, amountDue: 800, linkedCreditTotal: 0 })).toBe(0)
  })
  it("never returns negative", () => {
    expect(computeAppliedCredit({ gross: 1000, amountDue: 1200, linkedCreditTotal: 500 })).toBe(0)
  })
})

describe("buildRegeneratedLineItems", () => {
  it("appends a single credit line and nets the total", () => {
    const out = buildRegeneratedLineItems([svc("Installment 2 (Jun)", 1000)], 300)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ description: CREDIT_LINE_LABEL, unit_price: -300, amount: -300 })
    expect(sumLineAmounts(out)).toBe(700)
  })

  it("is a no-op (service lines unchanged, no credit line) when credit is 0", () => {
    const out = buildRegeneratedLineItems([svc("Installment 2 (Jun)", 1000)], 0)
    expect(out).toHaveLength(1)
    expect(sumLineAmounts(out)).toBe(1000)
  })

  it("strips an existing credit line before re-adding (idempotent re-run)", () => {
    const once = buildRegeneratedLineItems([svc("Installment 2 (Jun)", 1000)], 250)
    const twice = buildRegeneratedLineItems(once, 250)
    expect(twice).toHaveLength(2)
    expect(twice.filter((i) => i.amount < 0)).toHaveLength(1)
    expect(sumLineAmounts(twice)).toBe(750)
  })

  it("preserves multiple service lines in order", () => {
    const out = buildRegeneratedLineItems(
      [svc("Setup", 500), svc("Filing fee", 300, 1)],
      200,
    )
    expect(out.map((i) => i.description)).toEqual(["Setup", "Filing fee", CREDIT_LINE_LABEL])
    expect(sumLineAmounts(out)).toBe(600)
  })

  it("supports a custom credit label", () => {
    const out = buildRegeneratedLineItems([svc("Service", 1000)], 100, "Referral credit applied")
    expect(out[1].description).toBe("Referral credit applied")
  })

  it("handles an empty item list", () => {
    expect(buildRegeneratedLineItems([], 0)).toEqual([])
    expect(buildRegeneratedLineItems([], 100)).toEqual([
      { description: CREDIT_LINE_LABEL, quantity: 1, unit_price: -100, amount: -100 },
    ])
  })
})
