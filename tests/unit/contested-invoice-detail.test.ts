/**
 * The facts shown next to each invoice in the "more than one invoice fits this payment" box.
 * The real cases: the two IBDT LLC $1,000 invoices (1st installment paid Jan 20, 2nd installment
 * paid Sep 4) behind one Sep 3 Zelle, and Beril's six $15 invoices.
 */
import { describe, it, expect } from "vitest"
import {
  contestedPaymentIds,
  toContestedInvoiceDetail,
  contestedInvoiceFacts,
  formatCalendarDate,
  formatDetailAmount,
} from "@/lib/finance/contested-invoice-detail"

const tied = (ids: string[]) => ({
  review_metadata: {
    contested: { reason: "tied_candidates", at: "x", total: ids.length, candidates: ids.map((payment_id) => ({ payment_id })) },
  },
})

describe("contestedPaymentIds", () => {
  it("collects every distinct invoice named across rows", () => {
    expect(contestedPaymentIds([tied(["a", "b"]), tied(["b", "c"])]).sort()).toEqual(["a", "b", "c"])
  })
  it("ignores rows that are not tied, or have null / malformed metadata", () => {
    expect(contestedPaymentIds([{}, { review_metadata: null }, { review_metadata: { contested: null } }, { review_metadata: "x" }])).toEqual([])
  })
})

describe("contestedInvoiceFacts — the IBDT case", () => {
  const first = toContestedInvoiceDetail({
    id: "1", description: "First Installment – LLC Consulting & Management", installment: "Installment 1 (Jan)",
    total: 1000, amount_currency: "USD", invoice_status: "Paid", status: "Paid", paid_date: "2026-01-20",
  })
  const second = toContestedInvoiceDetail({
    id: "2", description: "2nd Installment 2026 — LLC Annual Management", installment: "Installment 2 (Jun)",
    total: 1000, amount_currency: "USD", invoice_status: "Paid", status: "Paid", paid_date: "2026-09-04",
  })
  it("shows what it is, the amount, and when it was paid", () => {
    expect(contestedInvoiceFacts(first)).toEqual({ what: "First Installment – LLC Consulting & Management", amount: "$1,000.00", state: "paid Jan 20, 2026" })
    expect(contestedInvoiceFacts(second).state).toBe("paid Sep 4, 2026")
  })
  it("makes the two invoices visibly different", () => {
    expect(contestedInvoiceFacts(first)).not.toEqual(contestedInvoiceFacts(second))
  })
})

describe("toContestedInvoiceDetail / contestedInvoiceFacts — edge cases", () => {
  it("reads Paid from the coarse status when invoice_status is blank", () => {
    const d = toContestedInvoiceDetail({ id: "x", total: 15, invoice_status: null, status: "Paid", paid_date: null })
    expect(d.paid).toBe(true)
    expect(contestedInvoiceFacts(d).state).toBe("paid (no date recorded)")
  })
  it("shows the status word for an invoice that is not paid", () => {
    const d = toContestedInvoiceDetail({ id: "x", total: 250, invoice_status: "Overdue", status: "Pending" })
    expect(contestedInvoiceFacts(d).state).toBe("Overdue")
  })
  it("falls back to the installment label, then to nothing, when there is no description", () => {
    expect(contestedInvoiceFacts(toContestedInvoiceDetail({ id: "x", installment: "Installment 2 (Jun)" })).what).toBe("Installment 2 (Jun)")
    expect(contestedInvoiceFacts(toContestedInvoiceDetail({ id: "x" })).what).toBeNull()
  })
  it("uses amount when total is missing and shows euros", () => {
    const d = toContestedInvoiceDetail({ id: "x", total: null, amount: "3000", amount_currency: "EUR" })
    expect(contestedInvoiceFacts(d).amount).toBe("€3,000.00")
  })
  it("never shows a missing amount as zero", () => {
    expect(formatDetailAmount(null, "USD")).toBeNull()
  })
  it("reads a date as a calendar day with no timezone shift", () => {
    expect(formatCalendarDate("2026-09-04")).toBe("Sep 4, 2026")
    expect(formatCalendarDate("2026-09-04T23:59:00+00:00")).toBe("Sep 4, 2026")
    expect(formatCalendarDate("garbage")).toBeNull()
    expect(formatCalendarDate(null)).toBeNull()
    expect(formatCalendarDate("2026-13-01")).toBeNull()
  })
})
