import { describe, it, expect } from "vitest"
import { invoiceStatusOf, isInvoiceOverdue, isInvoiceSettled, isCreditNote } from "@/lib/billing/invoice-status"

const today = "2026-08-30"

describe("invoiceStatusOf", () => {
  it("prefers invoice_status over status", () => {
    expect(invoiceStatusOf({ invoice_status: "Sent", status: "Pending", due_date: null })).toBe("Sent")
  })
  it("falls back to status when invoice_status is null", () => {
    expect(invoiceStatusOf({ invoice_status: null, status: "Overdue", due_date: null })).toBe("Overdue")
  })
})

describe("isInvoiceOverdue", () => {
  it("is true for invoice_status='Overdue' regardless of due date", () => {
    expect(isInvoiceOverdue({ invoice_status: "Overdue", status: null, due_date: null }, today)).toBe(true)
  })
  it("is true for a Sent invoice past its due date", () => {
    expect(isInvoiceOverdue({ invoice_status: "Sent", status: null, due_date: "2026-01-01" }, today)).toBe(true)
  })
  it("is false for a Sent invoice not yet due", () => {
    expect(isInvoiceOverdue({ invoice_status: "Sent", status: null, due_date: "2027-01-01" }, today)).toBe(false)
  })
  it("is false for a Draft invoice past due — Draft is 'outstanding' but not flagged overdue (TD never sent it)", () => {
    expect(isInvoiceOverdue({ invoice_status: "Draft", status: null, due_date: "2026-01-01" }, today)).toBe(false)
  })

  describe("regression: a partially-paid, past-due invoice must show as overdue (2026-08-31, bug-hunter finding)", () => {
    it("is true for a Partial invoice past its due date", () => {
      expect(isInvoiceOverdue({ invoice_status: "Partial", status: null, due_date: "2026-01-01" }, today)).toBe(true)
    })
    it("is false for a Partial invoice not yet due", () => {
      expect(isInvoiceOverdue({ invoice_status: "Partial", status: null, due_date: "2027-01-01" }, today)).toBe(false)
    })
  })
})

describe("isInvoiceSettled", () => {
  it.each(["Paid", "Cancelled", "Voided", "Split"])("treats %s as settled", (status) => {
    expect(isInvoiceSettled({ invoice_status: status, status: null, due_date: null })).toBe(true)
  })
  it.each(["Draft", "Sent", "Partial", "Overdue"])("treats %s as NOT settled — still counts as outstanding", (status) => {
    expect(isInvoiceSettled({ invoice_status: status, status: null, due_date: null })).toBe(false)
  })

  describe("regression: delegates to the codebase's one canonical settled-status module (2026-08-31, ai-architect + senior-engineer finding)", () => {
    it("treats status='Refunded' as settled even when invoice_status still reads Sent — money already returned isn't owed", () => {
      expect(isInvoiceSettled({ invoice_status: "Sent", status: "Refunded", due_date: null })).toBe(true)
    })
    it("treats status='Waived' as settled when invoice_status is absent", () => {
      expect(isInvoiceSettled({ invoice_status: null, status: "Waived", due_date: null })).toBe(true)
    })
    it("does NOT treat status='Cancelled' as settled when invoice_status is a genuinely open value (the Fiscalot case — a real open receivable with a stale status column)", () => {
      expect(isInvoiceSettled({ invoice_status: "Partial", status: "Cancelled", due_date: null })).toBe(false)
    })
  })

  describe("regression: a display-only amount_due=0 backstop (2026-08-31, Finance-Auditor finding, third council review)", () => {
    it("treats a Partial invoice as settled when its own remaining balance is exactly 0, even though status was never flipped to Paid", () => {
      expect(isInvoiceSettled({ invoice_status: "Partial", status: "Pending", due_date: "2026-01-01", amount_due: 0 })).toBe(true)
    })
    it("does NOT treat a Partial invoice as settled when amount_due is still positive", () => {
      expect(isInvoiceSettled({ invoice_status: "Partial", status: "Pending", due_date: "2026-01-01", amount_due: 250 })).toBe(false)
    })
    it("does NOT treat a Partial invoice as settled when amount_due is absent (never backfilled) — no false positive from a missing field", () => {
      expect(isInvoiceSettled({ invoice_status: "Partial", status: "Pending", due_date: "2026-01-01" })).toBe(false)
    })
    it("still respects the Fiscalot case even with amount_due present and positive — an open invoice_status with real money still owed", () => {
      expect(isInvoiceSettled({ invoice_status: "Partial", status: "Cancelled", due_date: null, amount_due: 500 })).toBe(false)
    })
  })
})

describe("isCreditNote", () => {
  it("treats a CN- prefixed invoice number as a credit note regardless of status", () => {
    expect(isCreditNote({ invoice_number: "CN-000123", invoice_status: "Draft", total: -150 })).toBe(true)
  })
  it("treats invoice_status='Credit' as a credit note even without the CN- prefix", () => {
    expect(isCreditNote({ invoice_number: "INV-000999", invoice_status: "Credit", total: -300 })).toBe(true)
  })
  it("treats a negative total as a credit note as a last-resort signal", () => {
    expect(isCreditNote({ invoice_number: "INV-001000", invoice_status: "Draft", total: -50 })).toBe(true)
  })
  it("does not flag an ordinary positive-total invoice as a credit note", () => {
    expect(isCreditNote({ invoice_number: "INV-001001", invoice_status: "Sent", total: 500 })).toBe(false)
  })
})
