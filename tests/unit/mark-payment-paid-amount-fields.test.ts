/**
 * Tests for markPaymentPaid — the old Payment Tracker page's bare-payment
 * Mark Paid handler. Regression test for the bug found 2026-09-06: it used
 * to flip status to Paid without ever writing amount_paid/amount_due,
 * leaving the row looking unpaid despite being marked Paid. A bare payment
 * only ever has `amount` set (never `total`), so the fix must read `amount`.
 *
 * The locked write path was rebuilt 2026-09-08 (dev job ef5da377, bug-hunter
 * pass) to a direct, row-count-checked write instead of routing through
 * updateWithLock — that helper's own conflict path silently falls through to
 * an unconditional clobber on a lock miss, which would have defeated the
 * exact race (a background bank-feed match landing between page-load and
 * click) this lock exists to catch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockUpdateWithLock,
  mockRevalidatePath,
  mockSingle,
  mockUpdate,
  mockUpdateEq,
  mockAdminUpdateEq,
  mockAdminUpdateEq2,
  mockAdminUpdateSelect,
} = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockAdminUpdateEq: vi.fn(),
  mockAdminUpdateEq2: vi.fn(),
  mockAdminUpdateSelect: vi.fn(),
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

// The locked path (updatedAt supplied) writes via supabaseAdmin directly —
// real chain: .update({...}).eq('id',...).eq('updated_at',...).select('id').
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      update: (updates: unknown) => {
        mockUpdate(updates)
        return {
          eq: (...args: unknown[]) => {
            mockAdminUpdateEq(...args)
            return {
              eq: (...args2: unknown[]) => {
                mockAdminUpdateEq2(...args2)
                return { select: (...args3: unknown[]) => mockAdminUpdateSelect(...args3) }
              },
            }
          },
        }
      },
    })),
  },
}))

import { markPaymentPaid } from "@/app/(dashboard)/payments/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: { amount: 1250 }, error: null })
  mockUpdateWithLock.mockResolvedValue({ success: true })
  mockUpdateEq.mockResolvedValue({ error: null })
  mockAdminUpdateEq.mockReturnValue(undefined)
  mockAdminUpdateEq2.mockReturnValue(undefined)
  mockAdminUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
})

describe("markPaymentPaid", () => {
  it("writes amount_paid from the payment's amount and zeroes amount_due (unlocked direct-write path)", async () => {
    const result = await markPaymentPaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Paid", amount_paid: 1250, amount_due: 0 }),
    )
  })

  it("writes amount_paid/amount_due via a direct row-count-checked write when an updatedAt lock is supplied, not updateWithLock", async () => {
    const result = await markPaymentPaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Paid", amount_paid: 1250, amount_due: 0 }),
    )
    expect(mockAdminUpdateEq).toHaveBeenCalledWith("id", PAYMENT_ID)
    expect(mockAdminUpdateEq2).toHaveBeenCalledWith("updated_at", "2026-01-01T00:00:00Z")
    // The bug-hunter's whole point: this must NEVER go through updateWithLock,
    // whose conflict path silently clobbers instead of refusing.
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })

  it("refuses instead of silently clobbering when the lock misses — a real concurrent change is not overwritten", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await markPaymentPaid(PAYMENT_ID, "stale-token")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since the page loaded/)
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
