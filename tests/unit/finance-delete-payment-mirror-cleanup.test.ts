/**
 * Tests for deletePayment (Finance / the Account page's delete action).
 * Regression coverage for two bugs found live on sandbox 2026-09-06 (dev job
 * ef5da377), the second unmasked by fixing the first in the same session:
 * (1) this used to delete the client_expenses mirror row directly, without
 * first clearing its own client_expense_items — that FK does not cascade,
 * so the delete failed every time an invoiced payment had recorded line
 * items. Now delegates to the shared deleteClientExpenseMirror helper (own
 * coverage in delete-client-expense-mirror.test.ts). (2) Once that was
 * fixed and re-tested live, the delete failed one step LATER on the exact
 * same shape of bug: it never deleted the invoice's own payment_items
 * either — that FK doesn't cascade too — so it had been broken all along,
 * just never reached because the mirror delete always failed first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockPaymentMaybeSingle,
  mockBankFeedsUpdateEq,
  mockPaymentItemsDeleteEq,
  mockPaymentsDeleteEq,
  mockDeleteClientExpenseMirror,
  mockListConfirmedApplications,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockPaymentMaybeSingle: vi.fn(),
  mockBankFeedsUpdateEq: vi.fn(),
  mockPaymentItemsDeleteEq: vi.fn(),
  mockPaymentsDeleteEq: vi.fn(),
  mockDeleteClientExpenseMirror: vi.fn(),
  mockListConfirmedApplications: vi.fn(),
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

vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  deleteClientExpenseMirror: (...args: unknown[]) => mockDeleteClientExpenseMirror(...args),
}))

vi.mock("@/lib/finance/apply-payment", () => ({
  listConfirmedApplications: (...args: unknown[]) => mockListConfirmedApplications(...args),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "payments") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockPaymentMaybeSingle })) })),
          delete: vi.fn(() => ({ eq: mockPaymentsDeleteEq })),
        }
      }
      if (table === "td_bank_feeds") {
        return { update: vi.fn(() => ({ eq: mockBankFeedsUpdateEq })) }
      }
      if (table === "payment_items") {
        return { delete: vi.fn(() => ({ eq: mockPaymentItemsDeleteEq })) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  },
}))

import { deletePayment } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockPaymentMaybeSingle.mockResolvedValue({
    data: { id: PAYMENT_ID, invoice_number: "INV-1", status: "Sent", invoice_status: "Sent", account_id: "acc-1" },
  })
  mockListConfirmedApplications.mockResolvedValue([])
  mockBankFeedsUpdateEq.mockResolvedValue({ error: null })
  mockDeleteClientExpenseMirror.mockResolvedValue(undefined)
  mockPaymentItemsDeleteEq.mockResolvedValue({ error: null })
  mockPaymentsDeleteEq.mockResolvedValue({ error: null })
})

describe("deletePayment", () => {
  it("cleans up the client-portal mirror, then the invoice's own line items, before deleting the payment", async () => {
    const result = await deletePayment(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockDeleteClientExpenseMirror).toHaveBeenCalledWith(PAYMENT_ID)
    expect(mockPaymentItemsDeleteEq).toHaveBeenCalledWith("payment_id", PAYMENT_ID)
    expect(mockPaymentsDeleteEq).toHaveBeenCalledWith("id", PAYMENT_ID)
  })

  it("surfaces a mirror-cleanup failure instead of silently leaving the row stuck (live bug #1 this fixes)", async () => {
    mockDeleteClientExpenseMirror.mockRejectedValue(
      new Error("Deleting the mirror's line items failed: update or delete on table violates foreign key constraint"),
    )
    const result = await deletePayment(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/line items failed/)
    expect(mockPaymentItemsDeleteEq).not.toHaveBeenCalled()
    expect(mockPaymentsDeleteEq).not.toHaveBeenCalled()
  })

  it("surfaces a payment_items cleanup failure instead of silently leaving the row stuck (live bug #2 this fixes — reproduced with a real invoice+line-item after fixing bug #1)", async () => {
    mockPaymentItemsDeleteEq.mockResolvedValue({
      error: { message: 'update or delete on table "payments" violates foreign key constraint "payment_items_payment_id_fkey" on table "payment_items"' },
    })
    const result = await deletePayment(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/line items failed/)
    expect(mockPaymentsDeleteEq).not.toHaveBeenCalled()
  })

  it("still refuses to delete an already-Paid payment", async () => {
    mockPaymentMaybeSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, invoice_number: "INV-1", status: "Paid", invoice_status: "Paid", account_id: "acc-1" },
    })
    const result = await deletePayment(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/void the invoice instead/)
    expect(mockDeleteClientExpenseMirror).not.toHaveBeenCalled()
  })

  it("still refuses to delete a payment with confirmed bank-feed money applied to it", async () => {
    mockListConfirmedApplications.mockResolvedValue([{ amount: 250 }])
    const result = await deletePayment(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Un-match the transaction/)
    expect(mockDeleteClientExpenseMirror).not.toHaveBeenCalled()
  })

  it("revalidates /finance, /payments, and the account page", async () => {
    await deletePayment(PAYMENT_ID)
    expect(mockRevalidatePath).toHaveBeenCalledWith("/finance")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/payments")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-1")
  })
})
