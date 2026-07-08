/**
 * S2 slice 6a — the operating-expense BREAKDOWN must sum to the P&L HEADLINE.
 * The old Math.abs breakdown drifted from the signed headline whenever a
 * vendor reversal (+amount inside expense/fee) or a refund row existed —
 * Dynamiq 2024: breakdown $2,067,145 vs headline $1,937,283, caught by the
 * client. Property pinned here: sum(buildExpenseBreakdown) === totalExpenses
 * (default-by-sign policy ON, the portal setting).
 */

import { describe, it, expect } from "vitest"
import { buildExpenseBreakdown, expenseBreakdownContribution, isOperatingExpenseRow, type ExpenseBucket } from "@/lib/tax/expense-buckets"
import { computePnlTotals } from "@/lib/pnl-generator"

const buckets: ExpenseBucket[] = [
  { slug: "software", label: "Software & SaaS", sort_order: 1 } as never,
  { slug: "contractors", label: "Contractors", sort_order: 2 } as never,
]

const rows = [
  { category: "expense", amount: -1000, ai_bucket: "software" },
  { category: "expense", amount: 250, ai_bucket: "software" },      // vendor reversal — contra
  { category: "fee", amount: -30, ai_bucket: null },
  { category: "refund", amount: 90, ai_bucket: "contractors" },     // refund received — contra
  { category: "refund", amount: -15, ai_bucket: "contractors" },    // refund paid out
  { category: "uncategorized", amount: -500, ai_bucket: null },     // defaulted outflow
  { category: "uncategorized", amount: 800, ai_bucket: null },      // defaulted inflow → income, NOT expenses
  { category: "income", amount: 5000, ai_bucket: null },
  { category: "cogs", amount: -700, ai_bucket: null },
  { category: "distribution", amount: -400, ai_bucket: null },
  { category: "contribution", amount: 900, ai_bucket: null },
  { category: "conversion", amount: -50, ai_bucket: null },
]

describe("expense breakdown ↔ headline consistency", () => {
  it("breakdown lines sum exactly to computePnlTotals.totalExpenses", () => {
    const breakdown = buildExpenseBreakdown(rows as never, buckets)
    const breakdownSum = breakdown.reduce((s, l) => s + l.total, 0)
    const headline = computePnlTotals(rows as never, { defaultUncategorizedBySign: true }).totalExpenses
    expect(breakdownSum).toBeCloseTo(headline, 6)
  })

  it("a vendor reversal REDUCES its bucket (never inflates)", () => {
    const breakdown = buildExpenseBreakdown(rows as never, buckets)
    const software = breakdown.find(l => l.slug === "software")
    expect(software?.total).toBeCloseTo(750, 6) // 1000 − 250
  })

  it("refund rows are part of the breakdown (they are part of the headline)", () => {
    expect(isOperatingExpenseRow("refund", 90)).toBe(true)
    const breakdown = buildExpenseBreakdown(rows as never, buckets)
    const contractors = breakdown.find(l => l.slug === "contractors")
    expect(contractors?.total).toBeCloseTo(-75, 6) // −90 + 15 — net money back
  })

  it("contribution helper is the negated signed amount", () => {
    expect(expenseBreakdownContribution(-100)).toBe(100)
    expect(expenseBreakdownContribution(40)).toBe(-40)
  })
})
