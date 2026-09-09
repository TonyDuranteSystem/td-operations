/**
 * Tests for Finance's markInvoicePaid.
 *
 * Rewritten 2026-09-09 (dev job 41e33dc5, full 6-reviewer council review):
 * this action now routes the actual write through applyMoneyToInvoice — the
 * shared, compare-and-swap-protected money writer — instead of a hand-rolled
 * update. The old raw update's only concurrency guard (.neq('status','Paid'))
 * shared its read with the paid-amount math, so a bank-feed partial payment
 * landing in between (which only ever moves invoice_status, never the coarse
 * status column) was invisible to it and could get silently overwritten by
 * the stale full total. applyMoneyToInvoice re-reads the row itself and its
 * write only lands if amount_paid still matches that fresh read.
 *
 * This file mocks applyMoneyToInvoice directly rather than the raw
 * supabaseAdmin update chain the old implementation used — the fallback math
 * (total ?? amount), the CAS, and the coherent status/amount tuple are all
 * applyMoneyToInvoice's own responsibility now and are covered by its own
 * test file (apply-payment.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockSingle,
  mockApplyMoneyToInvoice,
  mockSyncTDInvoiceMirror,
  mockTriggerActivationIfPending,
  mockSendPaidReceipt,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockApplyMoneyToInvoice: vi.fn(),
  mockSyncTDInvoiceMirror: vi.fn(),
  mockTriggerActivationIfPending: vi.fn(),
  mockSendPaidReceipt: vi.fn(),
}))

vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }),
}))

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mockSingle,
        })),
      })),
    })),
  },
}))

vi.mock("@/lib/finance/apply-payment", () => ({
  applyMoneyToInvoice: (...args: unknown[]) => mockApplyMoneyToInvoice(...args),
}))

vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  syncTDInvoiceMirror: (...args: unknown[]) => mockSyncTDInvoiceMirror(...args),
}))

vi.mock("@/lib/qb-sync", () => ({
  syncPaymentToQB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/operations/activate-service", () => ({
  triggerActivationIfPending: (...args: unknown[]) => mockTriggerActivationIfPending(...args),
}))

vi.mock("@/lib/invoice-auto-send", () => ({
  sendPaidReceipt: (...args: unknown[]) => mockSendPaidReceipt(...args),
}))

import { markInvoicePaid } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({
    data: { id: PAYMENT_ID, invoice_number: "INV-1", amount_paid: 0, invoice_status: "Sent", account_id: "acc-1" },
  })
  mockApplyMoneyToInvoice.mockResolvedValue({ applied: true, newStatus: "Paid", newAmountPaid: 1500, newAmountDue: 0 })
  mockSyncTDInvoiceMirror.mockResolvedValue(undefined)
  mockTriggerActivationIfPending.mockResolvedValue(undefined)
  mockSendPaidReceipt.mockResolvedValue(undefined)
})

describe("markInvoicePaid", () => {
  it("routes the write through the shared money writer in full-settle mode", async () => {
    const result = await markInvoicePaid(PAYMENT_ID, "Zelle")
    expect(result.success).toBe(true)
    expect(mockApplyMoneyToInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        mode: "settle_full",
        paymentMethod: "Zelle",
        actor: "finance:mark-paid",
      }),
    )
  })

  it("propagates the fetch error instead of calling the money writer", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(mockApplyMoneyToInvoice).not.toHaveBeenCalled()
  })

  // Regression test for the blocker found live 2026-09-07 (full council
  // review): a genuinely Partial invoice has real money already on file in
  // amount_paid. This action used to overwrite it with the full total
  // unconditionally — fabricating whatever the difference was as paid.
  // Kept as an explicit refusal (2026-09-09 review) rather than letting the
  // new writer net it out — that's a real product decision on Antonio's
  // list, not yet answered, and this preserves today's behavior until it is.
  it("refuses to mark Paid when the invoice already has a real partial payment on file, without calling the money writer", async () => {
    mockSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, invoice_number: "INV-1", amount_paid: 1000, invoice_status: "Partial", account_id: "acc-1" },
    })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already shows 1000 paid/)
    expect(mockApplyMoneyToInvoice).not.toHaveBeenCalled()
  })

  it("still allows Mark Paid when amount_paid is 0 or null (nothing paid yet)", async () => {
    mockSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, invoice_number: "INV-1", amount_paid: null, invoice_status: "Sent", account_id: "acc-1" },
    })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockApplyMoneyToInvoice).toHaveBeenCalled()
  })

  // Regression test for the blocker found live 2026-09-07 (full second-round
  // council review, confirmed independently by 3 reviewers): a credit note's
  // amount_paid is negative or zero, never positive, so the partial-payment
  // guard never recognized it. Gate on the row's real type instead.
  it("refuses to mark Paid on a credit note, regardless of amount_paid's sign, without calling the money writer", async () => {
    mockSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, invoice_number: "CN-1", amount_paid: -500, invoice_status: "Credit", account_id: "acc-1" },
    })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credit note/)
    expect(mockApplyMoneyToInvoice).not.toHaveBeenCalled()
  })

  it("refuses to mark Paid on a credit note even when amount_paid is 0 (a paid-call credit note before its follow-up write)", async () => {
    mockSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, invoice_number: "CN-2", amount_paid: 0, invoice_status: "Credit", account_id: "acc-1" },
    })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credit note/)
    expect(mockApplyMoneyToInvoice).not.toHaveBeenCalled()
  })

  // Core regression coverage for dev job 41e33dc5 (2026-09-09 council
  // review, Senior Engineer + Bug-Hunter, independently): applyMoneyToInvoice
  // reports a refusal (terminal invoice, zero-total, lost the compare-and-
  // swap) by RETURNING applied:false, not by throwing. Without an explicit
  // check, every side effect below would fire on a no-op — a false "paid"
  // receipt, a false "client paid" note, and a wrongful service activation.
  it("refuses and skips every side effect when the money writer reports applied:false", async () => {
    mockApplyMoneyToInvoice.mockResolvedValue({ applied: false, reason: "terminal", detail: "Invoice is closed." })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invoice is closed/)
    expect(mockSendPaidReceipt).not.toHaveBeenCalled()
    expect(mockSyncTDInvoiceMirror).not.toHaveBeenCalled()
    expect(mockTriggerActivationIfPending).not.toHaveBeenCalled()
  })

  it("falls back to a clear message when the money writer refuses with no detail", async () => {
    mockApplyMoneyToInvoice.mockResolvedValue({ applied: false, reason: "zero_amount" })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Nothing was applied/)
  })

  // Regression test for dev job ef5da377 (2026-09-07): this button (Finance's
  // own grid, and the Account page's row action, which calls this same
  // function) must check whether a client's setup was waiting on this
  // invoice — but only on a genuine, verified success.
  it("checks whether a client's setup was waiting on this invoice, only on genuine success", async () => {
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockTriggerActivationIfPending).toHaveBeenCalledWith(PAYMENT_ID)
  })

  it("syncs the client-portal mirror on a genuine Paid transition", async () => {
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockSyncTDInvoiceMirror).toHaveBeenCalledWith(PAYMENT_ID)
  })

  it("still sends the receipt on a genuine Paid transition", async () => {
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    // Fire-and-forget (a dynamic import().then(), never awaited by
    // markInvoicePaid itself) — give its microtask a tick to run before
    // asserting, same as production doesn't wait for it either.
    await vi.waitFor(() => expect(mockSendPaidReceipt).toHaveBeenCalledWith(PAYMENT_ID))
  })
})
