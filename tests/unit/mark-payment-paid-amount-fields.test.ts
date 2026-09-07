/**
 * Tests for markPaymentPaid — the old Payment Tracker page's bare-payment
 * Mark Paid handler. Regression test for the bug found 2026-09-06: it used
 * to flip status to Paid without ever writing amount_paid/amount_due,
 * leaving the row looking unpaid despite being marked Paid. A bare payment
 * only ever has `amount` set (never `total`), so the fix must read `amount`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockUpdateWithLock, mockRevalidatePath, mockSingle, mockUpdate, mockUpdateEq } = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
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
  updateWithLock: (...args: unknown[]) => mockUpdateWithLock(...args),
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
        return { eq: mockUpdateEq }
      },
    })),
  })),
}))

import { markPaymentPaid } from "@/app/(dashboard)/payments/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: { amount: 1250 }, error: null })
  mockUpdateWithLock.mockResolvedValue({ success: true })
  mockUpdateEq.mockResolvedValue({ error: null })
})

describe("markPaymentPaid", () => {
  it("writes amount_paid from the payment's amount and zeroes amount_due (direct-write path)", async () => {
    const result = await markPaymentPaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Paid", amount_paid: 1250, amount_due: 0 }),
    )
  })

  it("writes amount_paid/amount_due via updateWithLock when an updatedAt lock is supplied", async () => {
    const result = await markPaymentPaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "payments",
      PAYMENT_ID,
      expect.objectContaining({ status: "Paid", amount_paid: 1250, amount_due: 0 }),
      "2026-01-01T00:00:00Z",
    )
  })

  it("propagates the fetch error instead of writing a status flip with no amount", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } })
    const result = await markPaymentPaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })
})
