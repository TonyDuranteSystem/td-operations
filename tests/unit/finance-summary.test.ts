import { describe, it, expect } from "vitest"
import { summarizeInvoicesForFinanceCard } from "@/lib/billing/finance-summary"
import type { Payment } from "@/lib/types"

const base: Payment = {
  id: "p1",
  account_id: "acc-1",
  contact_id: null,
  deal_id: null,
  description: null,
  amount: 100,
  amount_currency: "USD",
  period: null,
  year: null,
  due_date: null,
  paid_date: null,
  status: null,
  payment_method: null,
  invoice_number: "INV-000001",
  installment: null,
  amount_paid: null,
  amount_due: null,
  followup_stage: null,
  delay_approved_until: null,
  notes: null,
  invoice_status: null,
  issue_date: null,
  subtotal: null,
  discount: null,
  total: null,
  message: null,
  sent_at: null,
  sent_to: null,
  reminder_count: null,
  last_reminder_at: null,
  qb_invoice_id: null,
  qb_sync_status: null,
  qb_sync_error: null,
  billing_entity_id: null,
  credit_for_payment_id: null,
  referral_partner_id: null,
} as Payment

const today = "2026-08-30"

function pmt(overrides: Partial<Payment>): Payment {
  return { ...base, id: overrides.id ?? `${Math.random()}`, ...overrides }
}

describe("summarizeInvoicesForFinanceCard", () => {
  it("counts a Paid invoice toward paid, not outstanding", () => {
    const result = summarizeInvoicesForFinanceCard(
      [pmt({ invoice_status: "Paid", total: 500 })],
      today,
    )
    expect(result.paidCount).toBe(1)
    expect(result.paidTotal).toBe(500)
    expect(result.outstandingCount).toBe(0)
  })

  it("classifies a Sent invoice past its due date as overdue, not pending", () => {
    const result = summarizeInvoicesForFinanceCard(
      [pmt({ invoice_status: "Sent", due_date: "2026-01-01", total: 200 })],
      today,
    )
    expect(result.overdueCount).toBe(1)
    expect(result.outstandingCount).toBe(1)
  })

  it("classifies a Sent invoice not yet due as pending, not overdue", () => {
    const result = summarizeInvoicesForFinanceCard(
      [pmt({ invoice_status: "Sent", due_date: "2027-01-01", total: 200 })],
      today,
    )
    expect(result.overdueCount).toBe(0)
    expect(result.outstandingCount).toBe(1)
  })

  it("excludes legacy pre-invoice rows (no real invoice_number, or the '1.0'/'2.0' placeholders)", () => {
    const result = summarizeInvoicesForFinanceCard(
      [
        pmt({ invoice_number: null, invoice_status: "Sent", total: 999 }),
        pmt({ invoice_number: "1.0", invoice_status: "Sent", total: 999 }),
      ],
      today,
    )
    expect(result.outstandingCount).toBe(0)
    expect(result.paidCount).toBe(0)
  })

  it("falls back through total → amount_due → amount when summing", () => {
    const result = summarizeInvoicesForFinanceCard(
      [
        pmt({ invoice_status: "Paid", total: null, amount_due: 50, amount: 999 }),
        pmt({ invoice_status: "Paid", total: null, amount_due: null, amount: 30 }),
      ],
      today,
    )
    expect(result.paidTotal).toBe(80)
  })

  it("returns all-zero on an empty invoice list", () => {
    const result = summarizeInvoicesForFinanceCard([], today)
    expect(result).toEqual({
      outstandingCount: 0,
      outstandingTotal: 0,
      overdueCount: 0,
      paidCount: 0,
      paidTotal: 0,
      currency: "USD",
    })
  })

  it("uses the first invoiced row's currency", () => {
    const result = summarizeInvoicesForFinanceCard(
      [pmt({ invoice_status: "Paid", amount_currency: "EUR", total: 10 })],
      today,
    )
    expect(result.currency).toBe("EUR")
  })
})
