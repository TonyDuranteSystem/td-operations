/**
 * Unit tests for lib/operations/payment.ts::closePaymentWithWriteOff — the
 * write-off step used by the Finance "link with a note" popup
 * (lib/finance/owner-transaction-link.ts).
 *
 * Kept in its own file rather than folded into operations-payment.test.ts:
 * that file's existing Supabase mock is shared, stateful, and shaped
 * specifically around confirmPayment/reconcilePaymentByInvoiceNumber's own
 * call patterns (its `.maybeSingle()` already resolves to a DIFFERENT
 * fixture for a different function) — extending it risked entangling this
 * function's tests with those, for no real benefit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

interface PaymentFixture {
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
  portal_invoice_id: string | null
  amount_paid: number | null
}

let paymentFixture: PaymentFixture | null = null
let paymentReadError: { message: string } | null = null
let paymentsWriteError: { message: string } | null = null
let clientInvoicesWriteError: { message: string } | null = null
const paymentsUpdateLog: Array<Record<string, unknown>> = []
const clientInvoicesUpdateLog: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payments") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: paymentFixture, error: paymentReadError }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            paymentsUpdateLog.push(patch)
            return { eq: () => Promise.resolve({ error: paymentsWriteError }) }
          },
        }
      }
      if (table === "client_invoices") {
        return {
          update: (patch: Record<string, unknown>) => {
            clientInvoicesUpdateLog.push(patch)
            return { eq: () => Promise.resolve({ error: clientInvoicesWriteError }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

import { closePaymentWithWriteOff } from "@/lib/operations/payment"

const basePayment: PaymentFixture = {
  invoice_number: "INV-002181",
  invoice_status: "Overdue",
  status: "Pending",
  portal_invoice_id: null,
  amount_paid: 600.02,
}

beforeEach(() => {
  paymentFixture = { ...basePayment }
  paymentReadError = null
  paymentsWriteError = null
  clientInvoicesWriteError = null
  paymentsUpdateLog.length = 0
  clientInvoicesUpdateLog.length = 0
})

describe("closePaymentWithWriteOff", () => {
  it("writes amount_due:0, status:Paid, invoice_status:Paid, paid_date and the note — never total", async () => {
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "2026-09-11: settlement note" })
    expect(result.success).toBe(true)
    expect(paymentsUpdateLog).toHaveLength(1)
    expect(paymentsUpdateLog[0]).toMatchObject({
      amount_due: 0,
      status: "Paid",
      invoice_status: "Paid",
      notes: "2026-09-11: settlement note",
    })
    expect(paymentsUpdateLog[0]).toHaveProperty("paid_date")
    // The whole point of this function: never touch `total` or line items —
    // the invoice really was for its full amount, TD just chose not to
    // collect the rest. See the function's own doc comment.
    expect(paymentsUpdateLog[0]).not.toHaveProperty("total")
  })

  it("computes hasRealInvoiceNumber itself — omits invoice_status for a legacy '1.0' placeholder", async () => {
    paymentFixture = { ...basePayment, invoice_number: "1.0" }
    await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(paymentsUpdateLog[0]).not.toHaveProperty("invoice_status")
    expect(paymentsUpdateLog[0]).toMatchObject({ status: "Paid", amount_due: 0 })
  })

  it("refuses when the invoice is not found", async () => {
    paymentFixture = null
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(paymentsUpdateLog).toHaveLength(0)
  })

  it("surfaces a read error instead of proceeding", async () => {
    paymentReadError = { message: "connection reset" }
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/connection reset/)
    expect(paymentsUpdateLog).toHaveLength(0)
  })

  // bug-hunter, second review round, 2026-09-11: the caller's own
  // terminal-invoice check runs BEFORE applyMoneyToInvoice, which is a step
  // stale by the time this function runs — re-checking here closes the
  // (narrow) window where the invoice was voided/cancelled in between.
  it("re-checks terminal status fresh and refuses if the invoice is now closed", async () => {
    paymentFixture = { ...basePayment, invoice_status: "Cancelled" }
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already/i)
    expect(paymentsUpdateLog).toHaveLength(0)
  })

  it("surfaces a database error instead of claiming success", async () => {
    paymentsWriteError = { message: "row is locked" }
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(result.success).toBe(false)
    expect(result.error).toBe("row is locked")
  })

  // bug-hunter, second review round: this function bypasses applyMoneyToInvoice
  // entirely (deliberately, to dodge its total-edit machinery), so it must
  // replicate the ONE thing that bypass skips — the legacy client_invoices
  // mirror — or the two silently disagree after a write-off.
  it("mirrors the close onto the legacy client_invoices link when portal_invoice_id is set", async () => {
    paymentFixture = { ...basePayment, portal_invoice_id: "ci-1" }
    await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(clientInvoicesUpdateLog).toHaveLength(1)
    expect(clientInvoicesUpdateLog[0]).toMatchObject({
      status: "Paid",
      amount_paid: 600.02,
      amount_due: 0,
    })
    expect(clientInvoicesUpdateLog[0]).toHaveProperty("paid_date")
  })

  it("does NOT touch client_invoices when portal_invoice_id is null", async () => {
    await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(clientInvoicesUpdateLog).toHaveLength(0)
  })

  it("still returns success when the payments write succeeded but the client_invoices mirror fails", async () => {
    paymentFixture = { ...basePayment, portal_invoice_id: "ci-1" }
    clientInvoicesWriteError = { message: "row is locked" }
    const result = await closePaymentWithWriteOff({ paymentId: "p1", notes: "note" })
    expect(result.success).toBe(true)
  })
})
