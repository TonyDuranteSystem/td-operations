/**
 * Tests for deleteInvoice (the old Payment Tracker page's exclusive
 * version). Regression coverage for the bug found 2026-09-06: deleting a
 * Draft invoice that already has a client_expenses mirror row (created
 * whenever the invoice was billed to a client account) used to fail with a
 * foreign-key error, because it never deleted the mirror first. That
 * cleanup now lives in the shared deleteClientExpenseMirror helper (see
 * delete-client-expense-mirror.test.ts for its own coverage) — this file
 * only tests that deleteInvoice calls it, surfaces its failures correctly,
 * and still enforces its own Draft-only guard on the delete itself, not
 * just on the earlier read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockCurrentSingle,
  mockDeleteClientExpenseMirror,
  mockPaymentItemsDeleteEq,
  mockPaymentsDeleteEq,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockCurrentSingle: vi.fn(),
  mockDeleteClientExpenseMirror: vi.fn(),
  mockPaymentItemsDeleteEq: vi.fn(),
  mockPaymentsDeleteEq: vi.fn(),
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "payments") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockCurrentSingle })) })),
          delete: vi.fn(() => ({ eq: vi.fn(() => ({ eq: mockPaymentsDeleteEq })) })),
        }
      }
      if (table === "payment_items") {
        return { delete: vi.fn(() => ({ eq: mockPaymentItemsDeleteEq })) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  })),
}))

import { deleteInvoice } from "@/app/(dashboard)/payments/invoice-actions"

const PAYMENT_ID = "inv-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockCurrentSingle.mockResolvedValue({ data: { invoice_status: "Draft", invoice_number: "INV-1" } })
  mockDeleteClientExpenseMirror.mockResolvedValue(undefined)
  mockPaymentItemsDeleteEq.mockResolvedValue({ error: null })
  mockPaymentsDeleteEq.mockResolvedValue({ error: null })
})

describe("deleteInvoice", () => {
  it("cleans up the mirror via the shared helper before deleting items and the invoice itself", async () => {
    const result = await deleteInvoice(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockDeleteClientExpenseMirror).toHaveBeenCalledWith(PAYMENT_ID)
    expect(mockPaymentItemsDeleteEq).toHaveBeenCalledWith("payment_id", PAYMENT_ID)
    expect(mockPaymentsDeleteEq).toHaveBeenCalledWith("invoice_status", "Draft")
  })

  it("re-checks Draft status on the delete call itself, not just on the earlier read", async () => {
    await deleteInvoice(PAYMENT_ID)
    // The delete chain must be .eq('id', paymentId).eq('invoice_status', 'Draft') —
    // covered by the mock shape requiring a second .eq before resolving.
    expect(mockPaymentsDeleteEq).toHaveBeenCalledWith("invoice_status", "Draft")
  })

  it("surfaces a mirror-cleanup failure as a failed result and never reaches the invoice delete", async () => {
    mockDeleteClientExpenseMirror.mockRejectedValue(new Error("client-portal mirror failed: still referenced"))
    const result = await deleteInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/still referenced/)
    expect(mockPaymentItemsDeleteEq).not.toHaveBeenCalled()
    expect(mockPaymentsDeleteEq).not.toHaveBeenCalled()
  })

  it("still refuses to delete a non-Draft invoice (existing guard untouched)", async () => {
    mockCurrentSingle.mockResolvedValue({ data: { invoice_status: "Sent", invoice_number: "INV-1" } })
    const result = await deleteInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Draft/)
    expect(mockDeleteClientExpenseMirror).not.toHaveBeenCalled()
    expect(mockPaymentsDeleteEq).not.toHaveBeenCalled()
  })

  it("revalidates both /payments and /finance", async () => {
    await deleteInvoice(PAYMENT_ID)
    expect(mockRevalidatePath).toHaveBeenCalledWith("/payments")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/finance")
  })

  it("surfaces a line-items cleanup failure instead of silently continuing to the invoice delete (this FK does not cascade, confirmed live 2026-09-06)", async () => {
    mockPaymentItemsDeleteEq.mockResolvedValue({ error: { message: "fk violation" } })
    const result = await deleteInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/line items failed/)
    expect(mockPaymentsDeleteEq).not.toHaveBeenCalled()
  })
})
