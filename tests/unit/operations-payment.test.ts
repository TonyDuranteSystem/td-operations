/**
 * P1.6 — lib/operations/payment.ts unit tests
 *
 * Focus: confirmPayment dispatch logic (installment handler routing based
 * on account_type + installment value). createInvoice / onInstallmentPaid
 * are thin re-exports of already-tested helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

interface PaymentRow {
  id: string
  account_id: string | null
  installment: string | null
  status: string
  portal_invoice_id: string | null
}

let paymentFixture: PaymentRow | null = null
let accountFixture: { account_type: string | null } | null = null
const paymentUpdateLog: Array<Record<string, unknown>> = []

// Result of the invoice-number lookup in reconcilePaymentByInvoiceNumber (maybeSingle).
let invoiceLookupFixture: { id: string; stripe_payment_id: string | null } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payments") {
        let filterId: string | null = null
        let pendingUpdate: Record<string, unknown> | null = null
        const chain = {
          select: vi.fn().mockReturnThis(),
          update: vi.fn((payload: Record<string, unknown>) => {
            pendingUpdate = payload
            return chain
          }),
          eq: vi.fn((_col: string, value: string) => {
            filterId = value
            if (pendingUpdate) {
              paymentUpdateLog.push({ id: value, ...pendingUpdate })
              pendingUpdate = null
            }
            return chain
          }),
          limit: vi.fn(() => chain),
          single: vi.fn(() => Promise.resolve({ data: paymentFixture, error: null })),
          maybeSingle: vi.fn(() => Promise.resolve({ data: invoiceLookupFixture, error: null })),
          then: (resolve: (v: { data: PaymentRow | null; error: null }) => void) =>
            resolve({ data: paymentFixture, error: null }),
        }
        // Suppress unused var warning — filterId is captured in closure for
        // the paymentUpdateLog push in .eq()
        void filterId
        return chain
      }
      if (table === "accounts") {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() => Promise.resolve({ data: accountFixture, error: null })),
        }
        return chain
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    },
  },
}))

const installmentCalls: Array<{ fn: string; account_id: string; year: number }> = []

vi.mock("@/lib/installment-handler", () => ({
  onFirstInstallmentPaid: vi.fn((account_id: string, year: number) => {
    installmentCalls.push({ fn: "first", account_id, year })
    return Promise.resolve({ steps: [{ step: "cmra_sd", status: "ok" }] })
  }),
  onSecondInstallmentPaid: vi.fn((account_id: string, year: number) => {
    installmentCalls.push({ fn: "second", account_id, year })
    return Promise.resolve({ steps: [{ step: "tax_gate", status: "ok" }] })
  }),
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  createTDInvoice: vi.fn(() =>
    Promise.resolve({
      paymentId: "pay-1",
      expenseId: "exp-1",
      invoiceNumber: "INV-000001",
      total: 100,
      status: "Paid",
    }),
  ),
  syncTDInvoiceStatus: vi.fn(() => Promise.resolve()),
  reconcileTDInvoiceMirror: vi.fn(() =>
    Promise.resolve({
      success: true,
      payment_id: "pay-1",
      changed: false,
    }),
  ),
}))

const syncCalls: Array<{
  source: string
  id: string
  status: string
  paid_date?: string
  amount?: number
}> = []

vi.mock("@/lib/portal/unified-invoice", () => ({
  syncInvoiceStatus: vi.fn(
    (source: string, id: string, status: string, paid_date?: string, amount?: number) => {
      syncCalls.push({ source, id, status, paid_date, amount })
      return Promise.resolve({ synced: true })
    },
  ),
}))

const receiptCalls: string[] = []
vi.mock("@/lib/invoice-auto-send", () => ({
  sendPaidReceipt: vi.fn((id: string) => {
    receiptCalls.push(id)
    return Promise.resolve()
  }),
}))

// The single money writer. confirmPayment no longer writes the payments row itself —
// it delegates to applyMoneyToInvoice, which owns the terminal-invoice refusal, the
// double-credit guard, the cap, the coherent status tuple, the mirrors, and the audit
// row. These tests assert confirmPayment's ORCHESTRATION on top of it.
const applyCalls: Array<Record<string, unknown>> = []
let applyResultFixture: Record<string, unknown> = { applied: true, newStatus: "Paid" }

vi.mock("@/lib/finance/apply-payment", () => ({
  applyMoneyToInvoice: vi.fn((params: Record<string, unknown>) => {
    applyCalls.push(params)
    return Promise.resolve(applyResultFixture)
  }),
}))

import { confirmPayment, reconcilePaymentByInvoiceNumber } from "@/lib/operations/payment"

beforeEach(() => {
  paymentFixture = null
  accountFixture = null
  invoiceLookupFixture = null
  paymentUpdateLog.length = 0
  installmentCalls.length = 0
  syncCalls.length = 0
  applyCalls.length = 0
  receiptCalls.length = 0
  applyResultFixture = { applied: true, newStatus: "Paid" }
})

describe("confirmPayment", () => {
  it("returns error when payment is not found", async () => {
    paymentFixture = null
    const result = await confirmPayment({ payment_id: "missing" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
  })

  it("returns already_paid when payment is already Paid", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Paid",
      portal_invoice_id: null,
    }
    const result = await confirmPayment({ payment_id: "p1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_paid")
    expect(installmentCalls).toHaveLength(0) // no side effects re-run
  })

  // Previously this branch called syncInvoiceStatus('invoice', …), which only touches
  // client_invoices — it NEVER wrote the payments row, yet confirmPayment still returned
  // "paid". The idempotency guard reads payment.status, the very column that branch never
  // wrote, so a retried Stripe webhook re-fired the installment handler and the receipt.
  it("writes through the single money writer even when portal_invoice_id is set", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending",
      portal_invoice_id: "inv-1",
    }
    await confirmPayment({ payment_id: "p1", paid_date: "2026-04-16", amount_paid: 250 })
    expect(applyCalls).toHaveLength(1)
    expect(applyCalls[0]).toMatchObject({
      paymentId: "p1",
      mode: "apply",
      appliedAmount: 250,
      paidDate: "2026-04-16",
    })
    expect(syncCalls).toHaveLength(0) // the old, payments-skipping path is gone
  })

  it("applies the caller's amount rather than assuming the invoice total", async () => {
    // The Stripe webhook passes the amount actually charged. Defaulting to the total
    // would silently turn a part-payment into a full credit.
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "One-Time" }
    await confirmPayment({ payment_id: "p1", paid_date: "2026-04-16", amount_paid: 250 })
    expect(applyCalls[0]).toMatchObject({ mode: "apply", appliedAmount: 250 })
  })

  it("settles in full when the caller passes no amount", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "One-Time" }
    await confirmPayment({ payment_id: "p1", paid_date: "2026-04-16" })
    expect(applyCalls[0]).toMatchObject({ mode: "settle_full" })
  })

  it("a PART payment is not a settlement — no installment handler, no paid receipt", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 1 (Jan)",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }
    applyResultFixture = { applied: true, newStatus: "Partial" }

    const result = await confirmPayment({ payment_id: "p1", paid_date: "2026-01-15", amount_paid: 100 })

    expect(result.outcome).toBe("partial")
    expect(installmentCalls).toHaveLength(0)
    expect(receiptCalls).toHaveLength(0)
  })

  it("reports already_paid (not success-with-no-write) when the writer refuses a closed invoice", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending", // stale status column; the writer sees the real state
      portal_invoice_id: null,
    }
    applyResultFixture = { applied: false, reason: "terminal", detail: "Invoice is already Paid" }

    const result = await confirmPayment({ payment_id: "p1" })

    expect(result.outcome).toBe("already_paid")
    expect(installmentCalls).toHaveLength(0)
    expect(receiptCalls).toHaveLength(0)
  })

  it("triggers onFirstInstallmentPaid for 'Installment 1 (Jan)' on Client accounts", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 1 (Jan)",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }
    const result = await confirmPayment({
      payment_id: "p1",
      paid_date: "2026-01-15",
    })
    expect(result.installment_handler).toMatchObject({
      triggered: true,
      number: 1,
      year: 2026,
    })
    expect(installmentCalls).toEqual([{ fn: "first", account_id: "a1", year: 2026 }])
  })

  it("triggers onSecondInstallmentPaid for 'Installment 2 (Jun)' on Client accounts", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 2 (Jun)",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }
    const result = await confirmPayment({
      payment_id: "p1",
      paid_date: "2026-06-30",
    })
    expect(result.installment_handler).toMatchObject({
      triggered: true,
      number: 2,
      year: 2026,
    })
    expect(installmentCalls).toEqual([{ fn: "second", account_id: "a1", year: 2026 }])
  })

  it("skips installment handler for non-Client account_type", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 1 (Jan)",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "One-Time" }
    const result = await confirmPayment({ payment_id: "p1" })
    expect(result.installment_handler).toMatchObject({
      triggered: false,
      reason: expect.stringMatching(/account_type=One-Time/),
    })
    expect(installmentCalls).toHaveLength(0)
  })

  it("skips installment handler for non-Installment-1/2 values (ITIN, Custom, etc.)", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "ITIN",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }
    const result = await confirmPayment({ payment_id: "p1" })
    expect(result.installment_handler).toMatchObject({
      triggered: false,
      reason: expect.stringMatching(/ITIN.*not Installment 1\/2/),
    })
    expect(installmentCalls).toHaveLength(0)
  })

  it("respects trigger_installment_handler=false opt-out", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 1 (Jan)",
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }
    const result = await confirmPayment({
      payment_id: "p1",
      trigger_installment_handler: false,
    })
    expect(result.installment_handler).toBeUndefined()
    expect(installmentCalls).toHaveLength(0)
  })
})

describe("reconcilePaymentByInvoiceNumber (channel-agnostic invoice reconcile)", () => {
  it("reconciles an OPEN invoice → marks Paid, fires installment handler, stamps stripe id", async () => {
    invoiceLookupFixture = { id: "p1", stripe_payment_id: null }
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 2 (Jun)",
      status: "Overdue",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }

    const r = await reconcilePaymentByInvoiceNumber("INV-002162", {
      amountPaid: 1000,
      paidDate: "2026-06-08",
      stripePaymentId: "pi_123",
    })

    expect(r.reconciled).toBe(true)
    expect(r.payment_id).toBe("p1")
    expect(installmentCalls).toEqual([{ fn: "second", account_id: "a1", year: 2026 }])
    expect(paymentUpdateLog.some(u => u.stripe_payment_id === "pi_123")).toBe(true)
  })

  it("does NOT reconcile an ALREADY-PAID invoice (lets a genuine 2nd payment record itself)", async () => {
    invoiceLookupFixture = { id: "p1", stripe_payment_id: null }
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: "Installment 2 (Jun)",
      status: "Paid",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "Client" }

    const r = await reconcilePaymentByInvoiceNumber("INV-002162", { amountPaid: 1000 })

    expect(r.reconciled).toBe(false)
    expect(r.outcome).toBe("already_paid")
    expect(installmentCalls).toHaveLength(0)
  })

  it("returns reconciled=false when no invoice matches the number", async () => {
    invoiceLookupFixture = null
    const r = await reconcilePaymentByInvoiceNumber("INV-NOPE", { amountPaid: 1000 })
    expect(r.reconciled).toBe(false)
    expect(r.outcome).toBeUndefined()
    expect(installmentCalls).toHaveLength(0)
  })
})
