import { describe, it, expect } from "vitest"
import { isMatchableInvoice, isTerminalInvoice, terminalReason } from "@/lib/finance/invoice-matchability"

/**
 * These cases are taken from REAL production rows (2026-07-14). The old predicate read
 * `invoice_status` alone; every failure below was a live money bug.
 */
describe("isMatchableInvoice — the two-column terminal rule", () => {
  it("keeps Draft matchable — invoice created at contract signing, payment can arrive first", () => {
    expect(isMatchableInvoice({ invoice_status: "Draft", status: "Pending" })).toBe(true)
  })

  it("keeps Sent matchable", () => {
    expect(isMatchableInvoice({ invoice_status: "Sent", status: "Pending" })).toBe(true)
  })

  it("keeps Overdue matchable", () => {
    expect(isMatchableInvoice({ invoice_status: "Overdue", status: "Overdue" })).toBe(true)
  })

  it("keeps Partial matchable — the remaining balance is still owed", () => {
    expect(isMatchableInvoice({ invoice_status: "Partial", status: "Pending" })).toBe(true)
  })

  it("excludes Paid", () => {
    expect(isMatchableInvoice({ invoice_status: "Paid", status: "Paid" })).toBe(false)
  })

  it("excludes Voided", () => {
    expect(isMatchableInvoice({ invoice_status: "Voided", status: "Waived" })).toBe(false)
  })

  it("excludes Cancelled", () => {
    expect(isMatchableInvoice({ invoice_status: "Cancelled", status: "Cancelled" })).toBe(false)
  })

  it("excludes Credit", () => {
    expect(isMatchableInvoice({ invoice_status: "Credit", status: "Paid" })).toBe(false)
  })

  // THE LANDMINE: 48 production invoices are Paid via `status` with a NULL invoice_status.
  // Reading invoice_status alone left them as live auto-match targets — a new payment of
  // the right amount could be credited to an invoice paid months ago.
  it("excludes an invoice that is Paid via `status` even when invoice_status is NULL", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Paid" })).toBe(false)
  })

  it("excludes an invoice Paid via `status` when invoice_status still says Sent (half-closed row)", () => {
    expect(isMatchableInvoice({ invoice_status: "Sent", status: "Paid" })).toBe(false)
  })

  it("excludes an invoice Cancelled via `status` even when invoice_status says Overdue", () => {
    expect(isMatchableInvoice({ invoice_status: "Overdue", status: "Cancelled" })).toBe(false)
  })

  // THE OTHER SIDE OF THE TRAP: a blanket "exclude NULL invoice_status" rule would have
  // made this real $1,250 open receivable permanently unmatchable AND hidden it from the
  // manual match list. NULL falls back to `status`, which says Overdue → still owed.
  it("KEEPS a genuine open receivable that has no invoice_status but status=Overdue", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Overdue" })).toBe(true)
  })

  it("excludes Refunded — the money went back to the client", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Refunded" })).toBe(false)
  })

  it("excludes Not Invoiced placeholder rows — there is no invoice to settle", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Not Invoiced" })).toBe(false)
  })

  it("treats an empty-string invoice_status as absent and falls back to status", () => {
    expect(isMatchableInvoice({ invoice_status: "  ", status: "Paid" })).toBe(false)
    expect(isMatchableInvoice({ invoice_status: "  ", status: "Overdue" })).toBe(true)
  })

  it("isTerminalInvoice is the exact inverse of isMatchableInvoice", () => {
    const rows = [
      { invoice_status: "Paid", status: "Paid" },
      { invoice_status: null, status: "Overdue" },
      { invoice_status: "Draft", status: "Pending" },
    ]
    for (const r of rows) {
      expect(isTerminalInvoice(r)).toBe(!isMatchableInvoice(r))
    }
  })
})

describe("terminalReason — the message staff sees when a match is refused", () => {
  it("names the invoice_status when that is what closed it", () => {
    expect(terminalReason({ invoice_status: "Paid", status: "Paid" })).toBe("Invoice is already Paid")
  })

  it("falls back to the payment status when invoice_status is blank", () => {
    expect(terminalReason({ invoice_status: null, status: "Cancelled" })).toBe("Invoice is already Cancelled")
  })

  it("returns null for an invoice that is still open", () => {
    expect(terminalReason({ invoice_status: "Sent", status: "Pending" })).toBeNull()
  })
})
