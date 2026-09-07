/**
 * Tests for markInvoicePaid (old Payment Tracker page, real invoices).
 * Regression test for the bug found 2026-09-06: it flipped a Sent/Overdue
 * invoice to Paid without ever writing amount_paid/amount_due, so a fully
 * settled invoice kept showing the full amount as still owed — and, via the
 * automatic client_expenses sync trigger, the client's own portal copy did
 * too. A real invoice always has `total` set (via createTDInvoice), so the
 * fix reads `total`, unlike the sibling bare-payment handler which reads
 * `amount`.
 *
 * The pending-activation follow-through (does this invoice un-stick a
 * client's setup?) moved to the shared triggerActivationIfPending() helper
 * 2026-09-07 (dev job ef5da377) — this file only checks that markInvoicePaid
 * delegates to it with the right id; the helper's own behavior is covered in
 * activate-service-lib.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockSingle,
  mockUpdate,
  mockUpdateIn,
  mockTriggerActivationIfPending,
  mockSendPaidReceipt,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateIn: vi.fn(),
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mockSingle,
        })),
      })),
      update: (updates: unknown) => {
        mockUpdate(updates)
        return { eq: () => ({ in: mockUpdateIn }) }
      },
    })),
  })),
}))

vi.mock("@/lib/operations/activate-service", () => ({
  triggerActivationIfPending: (...args: unknown[]) => mockTriggerActivationIfPending(...args),
}))

vi.mock("@/lib/invoice-auto-send", () => ({
  sendPaidReceipt: (...args: unknown[]) => mockSendPaidReceipt(...args),
}))

import { markInvoicePaid } from "@/app/(dashboard)/payments/invoice-actions"

const PAYMENT_ID = "inv-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: { total: 1200 }, error: null })
  mockUpdateIn.mockResolvedValue({ error: null })
  mockTriggerActivationIfPending.mockResolvedValue(undefined)
  mockSendPaidReceipt.mockResolvedValue(undefined)
})

describe("markInvoicePaid", () => {
  it("writes amount_paid from the invoice's total and zeroes amount_due", async () => {
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Paid",
        invoice_status: "Paid",
        amount_paid: 1200,
        amount_due: 0,
      }),
    )
  })

  it("still restricts the write to Sent/Overdue invoices (existing guard untouched)", async () => {
    await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(mockUpdateIn).toHaveBeenCalledWith("invoice_status", ["Sent", "Overdue"])
  })

  it("propagates the fetch error instead of writing a status flip with no amount", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } })
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("checks whether a client's setup was waiting on this invoice", async () => {
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockTriggerActivationIfPending).toHaveBeenCalledWith(PAYMENT_ID)
  })
})
