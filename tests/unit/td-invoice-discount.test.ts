import { describe, it, expect } from "vitest"
import { capDiscountForInvoice } from "@/lib/portal/td-invoice"

/**
 * Coverage for the discount bug (dev job 06fb1ad2): a discount typed on the
 * New Invoice form was stored but never reduced what the client was billed.
 * `capDiscountForInvoice` is the pure arithmetic createTDInvoice now uses to
 * fix that — these tests pin every scenario the 5-reviewer council pass
 * (senior-engineer, ai-architect, bug-hunter, project-director,
 * finance-auditor) found or verified before the fix shipped.
 */
describe("capDiscountForInvoice", () => {
  it("zero discount changes nothing — byte-identical to pre-fix behavior for all existing invoices", () => {
    const r = capDiscountForInvoice(0, 1000)
    expect(r).toEqual({ safeDiscount: 0, cappedDiscount: 0, creditEligibleAmount: 1000 })
  })

  it("undefined discount (every existing caller, pre-fix) behaves exactly like zero", () => {
    const r = capDiscountForInvoice(undefined, 1000)
    expect(r).toEqual({ safeDiscount: 0, cappedDiscount: 0, creditEligibleAmount: 1000 })
  })

  it("an ordinary discount reduces the credit-eligible amount by exactly the discount", () => {
    const r = capDiscountForInvoice(150, 1000)
    expect(r).toEqual({ safeDiscount: 150, cappedDiscount: 150, creditEligibleAmount: 850 })
  })

  it("the council's worked example: $500 gross, $400 discount -> $100 left for credit to cover", () => {
    // Finance-Auditor independently recomputed this against the real
    // computeCreditApplication cap logic and confirmed: only $100 of a $300
    // available credit balance gets consumed, not the full $300.
    const r = capDiscountForInvoice(400, 500)
    expect(r).toEqual({ safeDiscount: 400, cappedDiscount: 400, creditEligibleAmount: 100 })
  })

  it("a discount larger than the bill is capped at the bill, never persisted raw (bug-hunter minor)", () => {
    // A $500 discount typo'd onto a $100 invoice must not print "Discount
    // -$500" under "Subtotal $100" on the PDF — cap what's ACTUALLY stored.
    const r = capDiscountForInvoice(500, 100)
    expect(r).toEqual({ safeDiscount: 500, cappedDiscount: 100, creditEligibleAmount: 0 })
  })

  it("a discount exactly equal to the bill zeroes the credit-eligible amount, not negative", () => {
    const r = capDiscountForInvoice(1000, 1000)
    expect(r).toEqual({ safeDiscount: 1000, cappedDiscount: 1000, creditEligibleAmount: 0 })
  })

  it("a negative discount input is floored at 0 (defensive — schema already blocks this for the one live caller)", () => {
    const r = capDiscountForInvoice(-50, 1000)
    expect(r).toEqual({ safeDiscount: 0, cappedDiscount: 0, creditEligibleAmount: 1000 })
  })

  it("NaN discount input is treated as 0, not propagated as NaN", () => {
    const r = capDiscountForInvoice(Number.NaN, 1000)
    expect(r.cappedDiscount).toBe(0)
    expect(r.creditEligibleAmount).toBe(1000)
  })

  it("a negative grossTotal (referral/paid-call credit notes) with discount=0 never turns positive or throws", () => {
    // These two live callers (lib/operations/referral.ts, lib/operations/
    // paid-call-credit.ts) always pass discount=0 and rely on grossTotal
    // staying negative all the way to the final total (senior-engineer
    // blocker this fix had to preserve).
    const r = capDiscountForInvoice(0, -500)
    expect(r).toEqual({ safeDiscount: 0, cappedDiscount: 0, creditEligibleAmount: 0 })
  })

  it("a stray discount on a negative-gross invoice still can't go negative or exceed the (zero) floor", () => {
    const r = capDiscountForInvoice(50, -500)
    expect(r.cappedDiscount).toBe(0)
    expect(r.creditEligibleAmount).toBe(0)
  })

  it("PROPERTY: across a wide sweep, cappedDiscount is always between 0 and max(0, grossTotal), and creditEligibleAmount is never negative", () => {
    const grossTotals = [-1000, -1, 0, 0.01, 1, 50, 99.99, 500, 1000, 10000]
    const discounts = [undefined, -100, -0.01, 0, 0.01, 1, 50, 400, 500, 1000, 1000.01, 50000]

    let casesChecked = 0
    for (const gross of grossTotals) {
      for (const discount of discounts) {
        const r = capDiscountForInvoice(discount, gross)
        casesChecked++

        expect(r.cappedDiscount).toBeGreaterThanOrEqual(0)
        expect(r.cappedDiscount).toBeLessThanOrEqual(Math.max(0, gross))
        expect(r.creditEligibleAmount).toBeGreaterThanOrEqual(0)
        // For a real (positive) bill, creditEligibleAmount reconciles exactly.
        if (gross > 0) {
          expect(r.creditEligibleAmount).toBeCloseTo(gross - r.cappedDiscount, 10)
        }
        // Zero/undefined/negative discount input always yields cappedDiscount 0.
        if (!discount || discount <= 0) {
          expect(r.cappedDiscount).toBe(0)
        }
      }
    }
    expect(casesChecked).toBe(grossTotals.length * discounts.length)
  })
})
