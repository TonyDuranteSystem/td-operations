/**
 * A refund must REVERSE what it refunds, not vanish.
 *
 * THE BUG (found on real data, 2026-08-30): `refund` fell through the P&L switch
 * with no case, so it had zero effect. Two Airwallex payouts to a provider were
 * reversed and the money came back, but the books still reported the full €2,155
 * of professional services instead of the €2,020 actually spent — overstating the
 * expense by the refunded €135.
 *
 * Direction decides which side is reversed, unambiguously:
 *   money IN  reverses a payment we made   -> reduce expenses
 *   money OUT reverses money we received   -> reduce income
 *
 * Refunds were rare in this data; they will be common on the card statements.
 */
import { describe, it, expect } from "vitest"
import { computeOwnerPnL, type OwnerTransaction } from "@/lib/owner-finance"

const tx = (o: Partial<OwnerTransaction>): OwnerTransaction => ({
  id: Math.random().toString(36).slice(2),
  transaction_date: "2025-06-15",
  description: "t",
  counterparty: null,
  amount: 0,
  currency: "EUR",
  balance_after: null,
  bank_name: "Test",
  account_type: null,
  transaction_ref: null,
  category: "uncategorized",
  subcategory: null,
  is_related_party: false,
  notes: null,
  tax_year: 2025,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(o as any),
})

const NO_INVOICES = { year: 2025, byCurrency: {}, anomalies: [] }

const eur = (p: ReturnType<typeof computeOwnerPnL>) => p.blocks.find(b => b.currency === "EUR")!

describe("a refund of money we PAID reduces expenses", () => {
  it("nets the refund off the expense", () => {
    const p = computeOwnerPnL([
      tx({ category: "expense", subcategory: "professional_services", amount: -100 }),
      tx({ category: "refund", amount: 40 }), // money came back
    ], NO_INVOICES, 2025)
    // 100 spent, 40 returned => 60 actually spent.
    expect(eur(p).expenses).toBeCloseTo(60, 2)
  })

  it("the exact Airwallex case: €2,155 paid, €135 refunded", () => {
    const rows = [
      tx({ category: "expense", subcategory: "professional_services", amount: -2155 }),
      tx({ category: "refund", amount: 60 }),
      tx({ category: "refund", amount: 75 }),
    ]
    expect(eur(computeOwnerPnL(rows, NO_INVOICES, 2025)).expenses).toBeCloseTo(2020, 2)
  })

  it("REGRESSION: a refund is not silently ignored", () => {
    const withRefund = computeOwnerPnL([
      tx({ category: "expense", amount: -100 }),
      tx({ category: "refund", amount: 40 }),
    ], NO_INVOICES, 2025)
    const without = computeOwnerPnL([tx({ category: "expense", amount: -100 })], NO_INVOICES, 2025)
    expect(eur(withRefund).expenses).not.toBe(eur(without).expenses)
  })
})

describe("a refund of money we RECEIVED reduces income", () => {
  it("nets a client refund off income", () => {
    const p = computeOwnerPnL([
      tx({ category: "income", amount: 500 }),
      tx({ category: "refund", amount: -200 }), // paid back to a client
    ], NO_INVOICES, 2025)
    expect(eur(p).other_income).toBeCloseTo(300, 2)
  })
})

describe("what refunds must NOT disturb", () => {
  it("leaves transfers and conversions with no P&L effect", () => {
    // An income row is included so the currency block exists at all — a block with
    // ONLY transfers/conversions is dropped as having no reportable activity, which
    // is itself correct and was what this test first tripped over.
    const p = computeOwnerPnL([
      tx({ category: "income", amount: 1000 }),
      tx({ category: "transfer", amount: -5000 }),
      tx({ category: "conversion", amount: 19477.2 }),  // the buy leg
      tx({ category: "conversion", amount: -19000 }),   // the sell leg
    ], NO_INVOICES, 2025)
    // The conversion pair is Antonio's own money changing currency. Booking the buy
    // leg as income is exactly what invented ~$312k of revenue before.
    expect(eur(p).other_income).toBeCloseTo(1000, 2)
    expect(eur(p).expenses).toBe(0)
  })

  it("keeps the monthly series consistent with the annual expense figure", () => {
    // The chart's monthly numbers must move with the annual one, or they diverge.
    const p = computeOwnerPnL([
      tx({ category: "expense", amount: -100, transaction_date: "2025-06-15" }),
      tx({ category: "refund", amount: 40, transaction_date: "2025-06-20" }),
    ], NO_INVOICES, 2025)
    const june = eur(p).monthly[5]
    expect(june.expenses).toBeCloseTo(60, 2)
  })
})
