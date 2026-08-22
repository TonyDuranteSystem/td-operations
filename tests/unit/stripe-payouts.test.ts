import { describe, it, expect } from "vitest"
import { mapPayoutToRow, matchPayoutForDeposit, type StripePayoutRow } from "@/lib/finance/stripe-payouts"

describe("mapPayoutToRow", () => {
  it("converts cents→dollars, unix→date, preserves fields", () => {
    const row = mapPayoutToRow({
      id: "po_1TwX7bIHsqD3wMA9vjO89giQ",
      amount: 101925, // $1,019.25 in cents
      currency: "usd",
      arrival_date: 1784352000, // a real unix time
      status: "paid",
      livemode: true,
    })
    expect(row.id).toBe("po_1TwX7bIHsqD3wMA9vjO89giQ")
    expect(row.amount).toBe(1019.25)
    expect(row.arrival_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(row.status).toBe("paid")
    expect(row.livemode).toBe(true)
  })

  it("preserves the sign of a negative payout (money pulled back)", () => {
    const row = mapPayoutToRow({ id: "po_neg", amount: -5000, currency: "usd", arrival_date: 1784352000, status: "paid", livemode: true })
    expect(row.amount).toBe(-50)
  })
})

describe("matchPayoutForDeposit", () => {
  const payouts: StripePayoutRow[] = [
    { id: "po_a", amount: 1019.25, currency: "usd", arrival_date: "2026-07-24", status: "paid", livemode: true },
    { id: "po_b", amount: 2692.65, currency: "usd", arrival_date: "2026-07-17", status: "paid", livemode: true },
    { id: "po_c", amount: 970.7, currency: "usd", arrival_date: "2026-06-10", status: "paid", livemode: true },
  ]

  it("matches an exact amount on the same day", () => {
    expect(matchPayoutForDeposit(1019.25, "2026-07-24", "usd", payouts)?.id).toBe("po_a")
  })

  it("matches within the date window (bank post-date lags Stripe arrival)", () => {
    expect(matchPayoutForDeposit(2692.65, "2026-07-18", "usd", payouts)?.id).toBe("po_b")
  })

  it("does NOT match outside the date window", () => {
    expect(matchPayoutForDeposit(970.7, "2026-06-20", "usd", payouts)).toBeNull()
  })

  it("does NOT match a different amount", () => {
    expect(matchPayoutForDeposit(999.99, "2026-07-24", "usd", payouts)).toBeNull()
  })

  it("matches a payout stored with a negative sign on absolute value", () => {
    const negs: StripePayoutRow[] = [{ id: "po_n", amount: -60.87, currency: "usd", arrival_date: "2026-04-22", status: "paid", livemode: true }]
    expect(matchPayoutForDeposit(60.87, "2026-04-22", "usd", negs)?.id).toBe("po_n")
  })

  it("when two same-amount payouts are near, picks the closest date", () => {
    const two: StripePayoutRow[] = [
      { id: "po_far", amount: 500, currency: "usd", arrival_date: "2026-05-01", status: "paid", livemode: true },
      { id: "po_near", amount: 500, currency: "usd", arrival_date: "2026-05-03", status: "paid", livemode: true },
    ]
    expect(matchPayoutForDeposit(500, "2026-05-03", "usd", two)?.id).toBe("po_near")
  })

  it("handles cents without float drift (0.1 + 0.2 class)", () => {
    const p: StripePayoutRow[] = [{ id: "po_x", amount: 0.3, currency: "usd", arrival_date: "2026-01-01", status: "paid", livemode: true }]
    expect(matchPayoutForDeposit(0.3, "2026-01-01", "usd", p)?.id).toBe("po_x")
  })

  it("does NOT match a same-amount payout in a different currency", () => {
    const p: StripePayoutRow[] = [{ id: "po_eur", amount: 1000, currency: "eur", arrival_date: "2026-05-03", status: "paid", livemode: true }]
    expect(matchPayoutForDeposit(1000, "2026-05-03", "usd", p)).toBeNull()
  })

  it("currency comparison is case-insensitive (Stripe returns lowercase, caller may pass uppercase)", () => {
    const p: StripePayoutRow[] = [{ id: "po_case", amount: 1000, currency: "usd", arrival_date: "2026-05-03", status: "paid", livemode: true }]
    expect(matchPayoutForDeposit(1000, "2026-05-03", "USD", p)?.id).toBe("po_case")
  })

  it("filters currency BEFORE picking the closest date — a wrong-currency payout must not shadow a farther same-currency one", () => {
    const mixed: StripePayoutRow[] = [
      { id: "po_eur_close", amount: 1000, currency: "eur", arrival_date: "2026-05-03", status: "paid", livemode: true },
      { id: "po_usd_far", amount: 1000, currency: "usd", arrival_date: "2026-05-01", status: "paid", livemode: true },
    ]
    expect(matchPayoutForDeposit(1000, "2026-05-03", "usd", mixed)?.id).toBe("po_usd_far")
  })
})
