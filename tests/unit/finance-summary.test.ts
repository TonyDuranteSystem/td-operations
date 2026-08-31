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

/** The common single-currency case — most tests only care about one bucket. */
function one(payments: Payment[]) {
  const result = summarizeInvoicesForFinanceCard(payments, today)
  expect(result.byCurrency.length).toBeLessThanOrEqual(1)
  return result.byCurrency[0] ?? { currency: "USD", outstandingCount: 0, outstandingTotal: 0, overdueCount: 0, paidCount: 0, paidTotal: 0 }
}

describe("summarizeInvoicesForFinanceCard", () => {
  it("counts a Paid invoice toward paid, not outstanding", () => {
    const r = one([pmt({ invoice_status: "Paid", total: 500 })])
    expect(r.paidCount).toBe(1)
    expect(r.paidTotal).toBe(500)
    expect(r.outstandingCount).toBe(0)
  })

  it("classifies a Sent invoice past its due date as overdue, not pending", () => {
    const r = one([pmt({ invoice_status: "Sent", due_date: "2026-01-01", total: 200 })])
    expect(r.overdueCount).toBe(1)
    expect(r.outstandingCount).toBe(1)
  })

  it("classifies a Sent invoice not yet due as pending, not overdue", () => {
    const r = one([pmt({ invoice_status: "Sent", due_date: "2027-01-01", total: 200 })])
    expect(r.overdueCount).toBe(0)
    expect(r.outstandingCount).toBe(1)
  })

  it("excludes legacy pre-invoice rows (no real invoice_number, or the '1.0'/'2.0' placeholders)", () => {
    const r = one([
      pmt({ invoice_number: null, invoice_status: "Sent", total: 999 }),
      pmt({ invoice_number: "1.0", invoice_status: "Sent", total: 999 }),
    ])
    expect(r.outstandingCount).toBe(0)
    expect(r.paidCount).toBe(0)
  })

  it("returns all-zero on an empty invoice list", () => {
    const result = summarizeInvoicesForFinanceCard([], today)
    expect(result).toEqual({ byCurrency: [] })
  })

  it("groups totals per currency instead of stamping one currency on a mixed sum", () => {
    const result = summarizeInvoicesForFinanceCard(
      [
        pmt({ invoice_status: "Sent", due_date: "2027-01-01", amount_currency: "EUR", total: 1000 }),
        pmt({ invoice_status: "Sent", due_date: "2027-01-01", amount_currency: "USD", total: 500 }),
      ],
      today,
    )
    expect(result.byCurrency).toHaveLength(2)
    const eur = result.byCurrency.find((c) => c.currency === "EUR")
    const usd = result.byCurrency.find((c) => c.currency === "USD")
    expect(eur?.outstandingTotal).toBe(1000)
    expect(usd?.outstandingTotal).toBe(500)
  })

  it("sorts currency groups alphabetically, not by first-seen row order", () => {
    const result = summarizeInvoicesForFinanceCard(
      [
        pmt({ invoice_status: "Paid", amount_currency: "USD", total: 1 }),
        pmt({ invoice_status: "Paid", amount_currency: "EUR", total: 1 }),
      ],
      today,
    )
    expect(result.byCurrency.map((c) => c.currency)).toEqual(["EUR", "USD"])
  })

  describe("regressions found in the 2026-08-30 council review", () => {
    it("does not vanish a past-due Draft invoice — it counts as outstanding instead of matching no bucket", () => {
      const r = one([pmt({ invoice_status: "Draft", due_date: "2026-01-01", total: 3400 })])
      expect(r.outstandingCount).toBe(1)
      expect(r.outstandingTotal).toBe(3400)
    })

    it("does not vanish a past-due Partial invoice", () => {
      const r = one([pmt({ invoice_status: "Partial", due_date: "2026-01-01", total: 2000, amount_due: 1200 })])
      expect(r.outstandingCount).toBe(1)
      expect(r.outstandingTotal).toBe(1200)
    })

    it("sums the remaining balance for a partially-paid invoice, not the original face amount", () => {
      const r = one([pmt({ invoice_status: "Partial", total: 1000, amount_paid: 400, amount_due: 600 })])
      expect(r.outstandingTotal).toBe(600)
    })

    it("derives the remaining balance from total minus amount_paid when amount_due is null", () => {
      const r = one([pmt({ invoice_status: "Sent", due_date: "2027-01-01", total: 1000, amount_paid: 300, amount_due: null })])
      expect(r.outstandingTotal).toBe(700)
    })

    it("respects a genuine zero amount_due instead of falling through to total", () => {
      const r = one([pmt({ invoice_status: "Partial", total: 1000, amount_due: 0 })])
      expect(r.outstandingTotal).toBe(0)
    })

    it("excludes a credit note (CN- number) from outstanding even while still Draft — split-payment credits aren't retagged 'Credit' right away", () => {
      const r = one([pmt({ invoice_number: "CN-000001", invoice_status: "Draft", total: -150 })])
      expect(r.outstandingCount).toBe(0)
      expect(r.outstandingTotal).toBe(0)
    })

    it("excludes a credit note already tagged invoice_status='Credit'", () => {
      const r = one([pmt({ invoice_number: "CN-000002", invoice_status: "Credit", total: -300 })])
      expect(r.outstandingCount).toBe(0)
    })

    it("2026-08-31: a Paid invoice with a $0 total (fully discounted/credit-covered) reports what was actually collected (amount_paid), not a stale pre-discount amount", () => {
      const r = one([pmt({ invoice_status: "Paid", total: 0, amount_paid: 0, amount: 1000 })])
      expect(r.paidTotal).toBe(0)
    })

    it("2026-08-31: a partly-paid, past-due invoice now counts as overdue (not just outstanding)", () => {
      const r = one([pmt({ invoice_status: "Partial", due_date: "2026-01-01", total: 2000, amount_due: 1200 })])
      expect(r.overdueCount).toBe(1)
      expect(r.outstandingTotal).toBe(1200)
    })

    it("2026-08-31: a Refunded invoice (via status, invoice_status still Sent) is excluded from outstanding — money already returned isn't owed", () => {
      const r = one([pmt({ invoice_status: "Sent", status: "Refunded", due_date: "2026-01-01", total: 500 })])
      expect(r.outstandingCount).toBe(0)
      expect(r.overdueCount).toBe(0)
    })

    it("excludes Cancelled, Voided, and Split (a split-invoice parent is not itself a receivable)", () => {
      const r = one([
        pmt({ invoice_status: "Cancelled", total: 100 }),
        pmt({ invoice_status: "Voided", total: 100 }),
        pmt({ invoice_status: "Split", total: 100 }),
      ])
      expect(r.outstandingCount).toBe(0)
      expect(r.outstandingTotal).toBe(0)
    })
  })
})
