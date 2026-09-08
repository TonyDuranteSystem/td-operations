import { describe, it, expect } from "vitest"
import { computeInvoiceItemTotals, round2 } from "@/lib/finance/invoice-totals"

describe("round2", () => {
  it("corrects binary floating-point error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
  })
})

describe("computeInvoiceItemTotals", () => {
  it("recomputes each item's amount from quantity * unit_price, ignoring any amount the caller sent", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Service", quantity: 2, unit_price: 50, sort_order: 0 }],
      0,
    )
    expect(result.items[0].amount).toBe(100)
    expect(result.subtotal).toBe(100)
    expect(result.total).toBe(100)
  })

  it("rounds a repeating-decimal split to the cent instead of drifting", () => {
    // 3 lines at $33.33... (100/3) must total exactly 99.99 or 100.00, never 99.98999999999999.
    const result = computeInvoiceItemTotals(
      [
        { description: "A", quantity: 1, unit_price: 100 / 3 },
        { description: "B", quantity: 1, unit_price: 100 / 3 },
        { description: "C", quantity: 1, unit_price: 100 / 3 },
      ],
      0,
    )
    expect(Number.isInteger(result.subtotal * 100)).toBe(true)
    expect(Number.isInteger(result.total * 100)).toBe(true)
  })

  it("floors total at 0 when a discount exceeds the subtotal, instead of going negative", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Service", quantity: 1, unit_price: 50 }],
      500,
    )
    expect(result.total).toBe(0)
  })

  it("subtracts an ordinary discount normally", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Service", quantity: 1, unit_price: 100 }],
      20,
    )
    expect(result.total).toBe(80)
  })

  it("defaults sort_order to array index when not supplied", () => {
    const result = computeInvoiceItemTotals(
      [
        { description: "First", quantity: 1, unit_price: 10 },
        { description: "Second", quantity: 1, unit_price: 10 },
      ],
      0,
    )
    expect(result.items[0].sort_order).toBe(0)
    expect(result.items[1].sort_order).toBe(1)
  })

  it("preserves an explicit sort_order", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Line", quantity: 1, unit_price: 10, sort_order: 7 }],
      0,
    )
    expect(result.items[0].sort_order).toBe(7)
  })

  it("preserves item_type 'fee' on a line that already carries it", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Card processing fee", quantity: 1, unit_price: 5, item_type: "fee" }],
      0,
    )
    expect(result.items[0].item_type).toBe("fee")
  })

  it("defaults item_type to 'service' when absent", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Line", quantity: 1, unit_price: 10 }],
      0,
    )
    expect(result.items[0].item_type).toBe("service")
  })

  it("rejects an item_type outside the CHECK-constraint vocabulary rather than persisting garbage", () => {
    const result = computeInvoiceItemTotals(
      [{ description: "Line", quantity: 1, unit_price: 10, item_type: "bogus" as never }],
      0,
    )
    expect(result.items[0].item_type).toBe("service")
  })

  it("handles a negative unit_price line (e.g. a manual credit line within an ordinary invoice)", () => {
    const result = computeInvoiceItemTotals(
      [
        { description: "Service", quantity: 1, unit_price: 100 },
        { description: "Credit applied", quantity: 1, unit_price: -30 },
      ],
      0,
    )
    expect(result.subtotal).toBe(70)
    expect(result.total).toBe(70)
  })

  it("returns an empty result for an empty item list without throwing", () => {
    const result = computeInvoiceItemTotals([], 0)
    expect(result.items).toEqual([])
    expect(result.subtotal).toBe(0)
    expect(result.total).toBe(0)
  })
})
