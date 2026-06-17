import { describe, it, expect } from "vitest"
import { isStripePayoutFeed, resolveInvoiceStatusAfterPayment, isMatchableInvoiceStatus, partitionInvoicesForMultiMatch, planWaterfallAllocation } from "@/lib/bank-feed-matcher"

describe("isStripePayoutFeed", () => {
  // mercury (Plaid) pattern: full text in memo and sender_name
  it("matches mercury Plaid Stripe payout via memo", () => {
    expect(
      isStripePayoutFeed(
        "STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE",
        null,
      ),
    ).toBe(true)
  })

  // mercury_api pattern: memo is "STRIPE — STRIPE; TRANSFER; ..."
  it("matches mercury_api Stripe payout via memo", () => {
    expect(
      isStripePayoutFeed(
        "STRIPE — STRIPE; TRANSFER; TONY DURANTE LLC",
        "STRIPE; TRANSFER; TONY DURANTE LLC",
      ),
    ).toBe(true)
  })

  // match via sender_reference alone when memo is absent
  it("matches when only sender_reference contains STRIPE; TRANSFER", () => {
    expect(isStripePayoutFeed(null, "STRIPE; TRANSFER; TONY DURANTE LLC")).toBe(true)
  })

  // case-insensitive
  it("matches lowercase variant", () => {
    expect(isStripePayoutFeed("stripe; transfer; tony durante llc", null)).toBe(true)
  })

  // ordinary client wire — should not match
  it("does not match a regular client wire", () => {
    expect(isStripePayoutFeed("Payment from Acme LLC INV-001234", null)).toBe(false)
  })

  // memo mentions Stripe but not a payout transfer
  it("does not match a Stripe charge feed (source=stripe)", () => {
    expect(isStripePayoutFeed("Charge by Stripe for subscription", null)).toBe(false)
  })

  // nulls
  it("returns false when both fields are null", () => {
    expect(isStripePayoutFeed(null, null)).toBe(false)
  })

  it("returns false when both fields are empty strings", () => {
    expect(isStripePayoutFeed("", "")).toBe(false)
  })
})

describe("isMatchableInvoiceStatus", () => {
  it("matches Draft — created at contract signing, real obligation", () => {
    expect(isMatchableInvoiceStatus("Draft")).toBe(true)
  })

  it("matches Sent", () => {
    expect(isMatchableInvoiceStatus("Sent")).toBe(true)
  })

  it("matches Overdue", () => {
    expect(isMatchableInvoiceStatus("Overdue")).toBe(true)
  })

  it("matches Partial", () => {
    expect(isMatchableInvoiceStatus("Partial")).toBe(true)
  })

  it("excludes Paid", () => {
    expect(isMatchableInvoiceStatus("Paid")).toBe(false)
  })

  it("excludes Voided", () => {
    expect(isMatchableInvoiceStatus("Voided")).toBe(false)
  })

  it("excludes Cancelled", () => {
    expect(isMatchableInvoiceStatus("Cancelled")).toBe(false)
  })
})

describe("resolveInvoiceStatusAfterPayment", () => {
  it("marks Paid when payment covers the full balance", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 0, 1000)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountPaid).toBe(1000)
    expect(result.newAmountDue).toBe(0)
  })

  it("marks Partial when payment is less than the full balance", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 0, 200)
    expect(result.newStatus).toBe("Partial")
    expect(result.newAmountPaid).toBe(200)
    expect(result.newAmountDue).toBe(800)
  })

  it("accumulates correctly for installments — second payment of five", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 200, 200)
    expect(result.newStatus).toBe("Partial")
    expect(result.newAmountPaid).toBe(400)
    expect(result.newAmountDue).toBe(600)
  })

  it("marks Paid on the final installment", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 800, 200)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountPaid).toBe(1000)
    expect(result.newAmountDue).toBe(0)
  })

  it("clamps amount_due to 0 if overpaid", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 900, 200)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountDue).toBe(0)
  })
})

describe("partitionInvoicesForMultiMatch", () => {
  it("applies non-terminal invoices and skips terminal ones", () => {
    const { applicable, skippedIds } = partitionInvoicesForMultiMatch([
      { id: "a", invoice_status: "Sent" },
      { id: "b", invoice_status: "Paid" },
      { id: "c", invoice_status: "Partial" },
      { id: "d", invoice_status: "Voided" },
      { id: "e", invoice_status: "Cancelled" },
      { id: "f", invoice_status: "Credit" },
      { id: "g", invoice_status: "Draft" },
    ])
    expect(applicable.map((i) => i.id)).toEqual(["a", "c", "g"])
    expect(skippedIds).toEqual(["b", "d", "e", "f"])
  })

  it("treats null status as applicable", () => {
    const { applicable, skippedIds } = partitionInvoicesForMultiMatch([{ id: "a", invoice_status: null }])
    expect(applicable.map((i) => i.id)).toEqual(["a"])
    expect(skippedIds).toEqual([])
  })

  it("handles an empty selection", () => {
    const { applicable, skippedIds } = partitionInvoicesForMultiMatch([])
    expect(applicable).toEqual([])
    expect(skippedIds).toEqual([])
  })
})

describe("planWaterfallAllocation", () => {
  it("pays every invoice in full when the wire exactly covers the total", () => {
    const { allocations, leftover } = planWaterfallAllocation(1000, [
      { id: "a", total: 500, amount_paid: 0 },
      { id: "b", total: 300, amount_paid: 0 },
      { id: "c", total: 200, amount_paid: 0 },
    ])
    expect(allocations).toEqual([
      { payment_id: "a", applied: 500, balance: 500, status: "Paid" },
      { payment_id: "b", applied: 300, balance: 300, status: "Paid" },
      { payment_id: "c", applied: 200, balance: 200, status: "Paid" },
    ])
    expect(leftover).toBe(0)
  })

  it("UNDERPAYMENT: client owes 3000 but pays 2000 — last invoice left as debt", () => {
    // Two invoices of 1500 each (total owed 3000), wire of 2000.
    const { allocations, leftover } = planWaterfallAllocation(2000, [
      { id: "a", total: 1500, amount_paid: 0 },
      { id: "b", total: 1500, amount_paid: 0 },
    ])
    expect(allocations).toEqual([
      { payment_id: "a", applied: 1500, balance: 1500, status: "Paid" },
      { payment_id: "b", applied: 500, balance: 1500, status: "Partial" }, // 1000 stays as debt
    ])
    expect(leftover).toBe(0)
    const totalApplied = allocations.reduce((s, x) => s + x.applied, 0)
    expect(totalApplied).toBe(2000) // exactly the wire
  })

  it("stops funding once the wire is exhausted — trailing invoices get nothing (debt)", () => {
    const { allocations, leftover } = planWaterfallAllocation(500, [
      { id: "a", total: 500, amount_paid: 0 },
      { id: "b", total: 300, amount_paid: 0 }, // wire already spent — absent
    ])
    expect(allocations).toEqual([{ payment_id: "a", applied: 500, balance: 500, status: "Paid" }])
    expect(leftover).toBe(0)
  })

  it("OVERPAYMENT: wire exceeds total owed — all paid, surplus reported as leftover", () => {
    const { allocations, leftover } = planWaterfallAllocation(1000, [
      { id: "a", total: 300, amount_paid: 0 },
      { id: "b", total: 200, amount_paid: 0 },
    ])
    expect(allocations.map((a) => a.status)).toEqual(["Paid", "Paid"])
    expect(leftover).toBe(500)
  })

  it("uses remaining balance (total - amount_paid) for already-partial invoices", () => {
    const { allocations } = planWaterfallAllocation(300, [
      { id: "a", total: 1000, amount_paid: 800 }, // 200 remaining
      { id: "b", total: 500, amount_paid: 0 }, // gets the other 100
    ])
    expect(allocations).toEqual([
      { payment_id: "a", applied: 200, balance: 200, status: "Paid" },
      { payment_id: "b", applied: 100, balance: 500, status: "Partial" },
    ])
  })

  it("skips zero-balance invoices without burning the wire", () => {
    const { allocations } = planWaterfallAllocation(300, [
      { id: "a", total: 100, amount_paid: 100 }, // nothing owed — skipped
      { id: "b", total: 300, amount_paid: 0 },
    ])
    expect(allocations).toEqual([{ payment_id: "b", applied: 300, balance: 300, status: "Paid" }])
  })

  it("returns nothing for a zero/empty wire", () => {
    expect(planWaterfallAllocation(0, [{ id: "a", total: 500, amount_paid: 0 }])).toEqual({ allocations: [], leftover: 0 })
    expect(planWaterfallAllocation(500, [])).toEqual({ allocations: [], leftover: 500 })
  })
})
