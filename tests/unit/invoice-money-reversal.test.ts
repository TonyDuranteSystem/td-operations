/**
 * Taking one transaction's money back off an invoice — the money math.
 *
 * These cases are why the reversal does NOT reuse `resolveInvoiceStatusAfterPayment` with a
 * negative amount: that function only adds, caps at the invoice total, and can only return
 * Paid or Partial. Each test below is a state it would have produced wrongly.
 */

import { describe, it, expect } from "vitest"
import {
  resolveInvoiceStatusAfterReversal,
  resolveInvoiceStatusAfterPayment,
} from "@/lib/finance/invoice-money"

describe("resolveInvoiceStatusAfterReversal", () => {
  it("a fully reversed invoice is OPEN, not 'Partial with nothing paid'", () => {
    // The apply function fed a negative would return Partial here. An invoice reading
    // Partial with amount_paid 0 is incoherent, and both the overdue chaser and the client's
    // portal read it as a live part-payment.
    const r = resolveInvoiceStatusAfterReversal(1000, 1000, 1000)
    expect(r.newAmountPaid).toBe(0)
    expect(r.newAmountDue).toBe(1000)
    expect(r.newStatus).toBeNull()
    expect(r.keepPaidDate).toBe(false)
  })

  it("PRESERVES a part-payment that came from another rail", () => {
    // The old un-match blanket-wrote amount_paid = 0. A $2,200 invoice part-paid $1,700 by
    // card and $500 by wire would have had the client's $1,700 erased by un-matching the wire.
    const r = resolveInvoiceStatusAfterReversal(2200, 2200, 500)
    expect(r.newAmountPaid).toBe(1700)
    expect(r.newAmountDue).toBe(500)
    expect(r.newStatus).toBe("Partial")
    expect(r.keepPaidDate).toBe(true)
  })

  it("stays Paid when the remaining money still covers the invoice", () => {
    const r = resolveInvoiceStatusAfterReversal(1000, 1000, 0)
    expect(r.newStatus).toBe("Paid")
    expect(r.newAmountDue).toBe(0)
  })

  it("never drives the invoice negative, even if the ledger row over-states the credit", () => {
    // A legacy row written before the over-credit cap existed could record the full $650 wire
    // against a $500 balance. Un-clamped, the client would be told they owe MORE than the
    // invoice.
    const r = resolveInvoiceStatusAfterReversal(500, 500, 650)
    expect(r.newAmountPaid).toBe(0)
    expect(r.newAmountDue).toBe(500)
    expect(r.newStatus).toBeNull()
  })

  it("is idempotent — reversing twice cannot go below zero", () => {
    const once = resolveInvoiceStatusAfterReversal(1000, 1000, 1000)
    const twice = resolveInvoiceStatusAfterReversal(1000, once.newAmountPaid, 1000)
    expect(twice.newAmountPaid).toBe(0)
    expect(twice.newAmountDue).toBe(1000)
  })

  it("survives an invoice total edited DOWNWARDS after the money arrived", () => {
    // Invoice cut to $400 after two $500 wires. Reversing one must leave the other $500 on
    // record — the apply function's cap would have silently destroyed $100 of client cash.
    const r = resolveInvoiceStatusAfterReversal(400, 1000, 500)
    expect(r.newAmountPaid).toBe(500)
    expect(r.newStatus).toBe("Paid")
    expect(r.newAmountDue).toBe(0)
  })

  it("rounds to cents", () => {
    const r = resolveInvoiceStatusAfterReversal(1000, 0.3, 0.1)
    expect(r.newAmountPaid).toBe(0.2)
  })

  it("treats a negative or zero credited amount as nothing to remove", () => {
    expect(resolveInvoiceStatusAfterReversal(1000, 600, 0).newAmountPaid).toBe(600)
    expect(resolveInvoiceStatusAfterReversal(1000, 600, -50).newAmountPaid).toBe(600)
  })

  it("a round trip through apply then reverse returns the original balance", () => {
    const applied = resolveInvoiceStatusAfterPayment(1000, 250, 500)
    expect(applied.newAmountPaid).toBe(750)
    const reversed = resolveInvoiceStatusAfterReversal(1000, applied.newAmountPaid, 500)
    expect(reversed.newAmountPaid).toBe(250)
    expect(reversed.newStatus).toBe("Partial")
  })
})
