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
          single: vi.fn(() => Promise.resolve({ data: paymentFixture, error: null })),
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

import { confirmPayment } from "@/lib/operations/payment"

beforeEach(() => {
  paymentFixture = null
  accountFixture = null
  paymentUpdateLog.length = 0
  installmentCalls.length = 0
  syncCalls.length = 0
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

  it("routes through syncInvoiceStatus when portal_invoice_id is set", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending",
      portal_invoice_id: "inv-1",
    }
    await confirmPayment({ payment_id: "p1", paid_date: "2026-04-16", amount_paid: 250 })
    expect(syncCalls).toEqual([
      { source: "invoice", id: "inv-1", status: "Paid", paid_date: "2026-04-16", amount: 250 },
    ])
    expect(paymentUpdateLog).toHaveLength(0) // direct .update() path not taken
  })

  it("uses direct payments.update when no portal_invoice_id", async () => {
    paymentFixture = {
      id: "p1",
      account_id: "a1",
      installment: null,
      status: "Pending",
      portal_invoice_id: null,
    }
    accountFixture = { account_type: "One-Time" }
    await confirmPayment({ payment_id: "p1", paid_date: "2026-04-16", amount_paid: 250 })
    expect(paymentUpdateLog).toHaveLength(1)
    expect(paymentUpdateLog[0]).toMatchObject({
      id: "p1",
      status: "Paid",
      paid_date: "2026-04-16",
      amount_paid: 250,
    })
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
