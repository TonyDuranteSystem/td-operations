import { describe, it, expect } from "vitest"
import {
  buildRegeneratedLineItems,
  computeAppliedCredit,
  computeClickToApplyCredit,
  isCreditLine,
  sumLineAmounts,
  adjustSingleServiceLineForTotal,
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

describe("computeClickToApplyCredit", () => {
  it("applies available credit to a fresh invoice (Wise Strategies June case)", () => {
    // gross 1000, no cash, no existing credit, $250 available → apply 250, owe 750
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 0, available: 250 }))
      .toEqual({ newApply: 250, totalCredit: 250, newTotal: 750, newDue: 750, settled: false })
  })

  it("caps applied credit at what is owed (credit larger than the invoice)", () => {
    // $1500 available against a $1000 invoice → apply only 1000, settle, 500 stays available
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 0, available: 1500 }))
      .toEqual({ newApply: 1000, totalCredit: 1000, newTotal: 0, newDue: 0, settled: true })
  })

  it("is idempotent on re-click — no available credit left, existing line preserved", () => {
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 250, available: 0 }))
      .toEqual({ newApply: 0, totalCredit: 250, newTotal: 750, newDue: 750, settled: false })
  })

  it("respects real cash already paid (credit only fills the remaining headroom)", () => {
    // gross 1000, 300 real cash, 250 available → headroom 700, apply 250, owe 450
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 300, existingCredit: 0, available: 250 }))
      .toEqual({ newApply: 250, totalCredit: 250, newTotal: 750, newDue: 450, settled: false })
  })

  it("tops up an existing partial credit with more available credit", () => {
    // gross 1000, existing credit line 200, 500 available → headroom 800, apply 500, total credit 700
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 200, available: 500 }))
      .toEqual({ newApply: 500, totalCredit: 700, newTotal: 300, newDue: 300, settled: false })
  })

  it("does nothing when there is no credit (existing or available)", () => {
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 0, available: 0 }))
      .toEqual({ newApply: 0, totalCredit: 0, newTotal: 1000, newDue: 1000, settled: false })
  })

  it("never over-applies when the invoice is already fully paid in cash", () => {
    expect(computeClickToApplyCredit({ gross: 1000, cashPaid: 1000, existingCredit: 0, available: 250 }))
      .toEqual({ newApply: 0, totalCredit: 0, newTotal: 1000, newDue: 0, settled: true })
  })

  it("rounds money to cents", () => {
    const r = computeClickToApplyCredit({ gross: 1000, cashPaid: 0, existingCredit: 0, available: 333.335 })
    expect(r.newApply).toBeCloseTo(333.34, 2)
    expect(r.newTotal).toBeCloseTo(666.66, 2)
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
      // item_type carried through for card-fee safety (dev_task 6ec6872a); a credit
      // line is a service adjustment.
      { description: CREDIT_LINE_LABEL, quantity: 1, unit_price: -100, amount: -100, item_type: "service" },
    ])
  })
})

describe("adjustSingleServiceLineForTotal", () => {
  it("adjusts the one service line to match the new total (ShoppyVerse shape: single line, no credit)", () => {
    const r = adjustSingleServiceLineForTotal(
      [{ ...svc("LLC Annual Management — 2nd Installment 2026", 2000), item_type: "service" }],
      1000,
    )
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ description: "LLC Annual Management — 2nd Installment 2026", unit_price: 1000, amount: 1000 })
    expect(sumLineAmounts(r.items)).toBe(1000)
  })

  it("leaves an existing credit line untouched and adjusts only the service line (Growly shape)", () => {
    const items = [
      { ...svc("LLC Annual Management — 2nd Installment 2026", 1000), item_type: "service" },
      { description: CREDIT_LINE_LABEL, quantity: 1, unit_price: -200, amount: -200, item_type: "service" },
    ]
    // Correcting the total to 849 (the true gross) minus the untouched -200 credit → service line becomes 649.
    const r = adjustSingleServiceLineForTotal(items, 649)
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({ unit_price: 849, amount: 849 })
    expect(r.items[1]).toMatchObject({ description: CREDIT_LINE_LABEL, unit_price: -200, amount: -200 })
    expect(sumLineAmounts(r.items)).toBe(649)
  })

  it("refuses when there is no service line to adjust", () => {
    const r = adjustSingleServiceLineForTotal(
      [{ description: CREDIT_LINE_LABEL, quantity: 1, unit_price: -200, amount: -200 }],
      500,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no service line/i)
    expect(r.items).toHaveLength(1) // unchanged, returned as-is
  })

  it("refuses when there is more than one service line (ambiguous which one to adjust)", () => {
    const r = adjustSingleServiceLineForTotal(
      [svc("Setup", 500), svc("Filing fee", 300)],
      600,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/more than one line/i)
  })

  it("refuses when the one non-credit line is a card-processing fee — never lets a total edit silently absorb the fee", () => {
    const r = adjustSingleServiceLineForTotal(
      [{ description: "Card processing fee", quantity: 1, unit_price: 50, amount: 50, item_type: "fee" }],
      75,
    )
    expect(r.ok).toBe(false)
  })

  it("refuses when a real service line sits alongside a fee line (two non-credit lines)", () => {
    const r = adjustSingleServiceLineForTotal(
      [
        { ...svc("Installment 2 (Jun)", 1000), item_type: "service" },
        { description: "Card processing fee", quantity: 1, unit_price: 50, amount: 50, item_type: "fee" },
      ],
      1100,
    )
    expect(r.ok).toBe(false)
  })

  it("preserves quantity, recomputing unit_price so quantity × unit_price = the corrected amount", () => {
    const r = adjustSingleServiceLineForTotal(
      [{ description: "Monthly fee", quantity: 4, unit_price: 100, amount: 400 }],
      600,
    )
    expect(r.ok).toBe(true)
    expect(r.items[0]).toMatchObject({ quantity: 4, unit_price: 150, amount: 600 })
  })

  it("rounds money to cents", () => {
    const r = adjustSingleServiceLineForTotal([svc("Service", 1000)], 333.335)
    expect(r.ok).toBe(true)
    expect(r.items[0].amount).toBeCloseTo(333.34, 2)
  })
})
