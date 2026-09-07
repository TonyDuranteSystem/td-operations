/**
 * Tests for the OLD Payment Tracker page's voidInvoice
 * (app/(dashboard)/payments/invoice-actions.ts) — the temporary duplicate
 * bridge built 2026-09-07 (E2E production QA sweep, Antonio's explicit call).
 *
 * Two real gaps closed, mirroring Finance's own (already-tested) voidInvoice:
 * (1) this now writes the SAME cancellation vocabulary as the new page
 *     (status/invoice_status='Cancelled', not the old 'Waived'/'Voided') —
 *     the old labels made a voided-here invoice permanently un-reactivatable,
 *     since Reactivate only recognizes literal 'Cancelled'.
 * (2) a matched bank feed used to be left dangling on void — the money
 *     stayed recorded against a cancelled invoice with no way back into the
 *     review queue.
 *
 * The underlying pure helpers (capturePreVoidState, partitionFeedsForUnlink)
 * already have their own dedicated coverage in invoice-reactivate.test.ts —
 * this file only tests that voidInvoice here is WIRED to them correctly,
 * mocked at the module boundary rather than re-proving their own logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockMaybeSingle,
  mockPaymentsUpdate,
  mockPaymentsUpdateEq,
  mockPaymentsUpdateIn,
  mockPaymentsUpdateSelect,
  mockFeedsSelect,
  mockFeedsUpdate,
  mockCapturePreVoidState,
  mockPartitionFeedsForUnlink,
  mockListConfirmedApplications,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockPaymentsUpdate: vi.fn(),
  mockPaymentsUpdateEq: vi.fn(),
  mockPaymentsUpdateIn: vi.fn(),
  mockPaymentsUpdateSelect: vi.fn(),
  mockFeedsSelect: vi.fn(),
  mockFeedsUpdate: vi.fn(),
  mockCapturePreVoidState: vi.fn(),
  mockPartitionFeedsForUnlink: vi.fn(),
  mockListConfirmedApplications: vi.fn(),
}))

vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }),
}))

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

vi.mock("@/lib/billing/invoice-reactivate", () => ({
  capturePreVoidState: (...args: unknown[]) => mockCapturePreVoidState(...args),
  partitionFeedsForUnlink: (...args: unknown[]) => mockPartitionFeedsForUnlink(...args),
}))

vi.mock("@/lib/finance/apply-payment", () => ({
  listConfirmedApplications: (...args: unknown[]) => mockListConfirmedApplications(...args),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "td_bank_feeds") {
        return {
          select: vi.fn(() => ({ eq: mockFeedsSelect })),
          update: (updates: unknown) => {
            mockFeedsUpdate(updates)
            return { in: vi.fn().mockResolvedValue({ error: null }) }
          },
        }
      }
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
        update: (updates: unknown) => {
          mockPaymentsUpdate(updates)
          return {
            eq: (...args: unknown[]) => {
              mockPaymentsUpdateEq(...args)
              return {
                in: (...inArgs: unknown[]) => {
                  mockPaymentsUpdateIn(...inArgs)
                  return { select: mockPaymentsUpdateSelect }
                },
              }
            },
          }
        },
      }
    }),
  },
}))

import { voidInvoice } from "@/app/(dashboard)/payments/invoice-actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockMaybeSingle.mockResolvedValue({
    data: { id: PAYMENT_ID, qb_invoice_id: null, status: "Sent", invoice_status: "Sent", amount_due: 500, amount_paid: 0, paid_date: null, credit_remaining: null },
  })
  mockCapturePreVoidState.mockReturnValue({ status: "Sent", invoice_status: "Sent" })
  mockPaymentsUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
  mockFeedsSelect.mockResolvedValue({ data: [], error: null })
  mockListConfirmedApplications.mockResolvedValue([])
  mockPartitionFeedsForUnlink.mockReturnValue({ resetIds: [], clearIds: [] })
})

describe("old page's voidInvoice — unified cancellation vocabulary", () => {
  it("writes status/invoice_status='Cancelled', matching the new page (not the old 'Waived'/'Voided')", async () => {
    const result = await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockPaymentsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Cancelled", invoice_status: "Cancelled" }),
    )
  })

  it("still restricts the write to Draft/Sent/Overdue invoices (existing eligibility, unchanged)", async () => {
    await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(mockPaymentsUpdateIn).toHaveBeenCalledWith("invoice_status", ["Draft", "Sent", "Overdue"])
  })

  it("captures a pre-void snapshot for Reactivate to read back later", async () => {
    await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(mockCapturePreVoidState).toHaveBeenCalled()
  })

  // Regression coverage for a bug caught by a second QA round on the ACTUAL
  // built code (Senior Engineer + Bug-Hunter, independently): this write had
  // no row-count check, so a stale dialog (the row's real status moved on
  // between opening it and clicking Void) silently matched zero rows yet
  // still fell through into the bank-feed-release logic and reported
  // success — undoing a real bank-feed match while the payments row itself
  // was never touched.
  it("refuses and skips bank-feed release when the update matches zero rows (stale dialog)", async () => {
    mockPaymentsUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no longer be Draft, Sent, or Overdue/)
    expect(mockFeedsSelect).not.toHaveBeenCalled()
    expect(mockPartitionFeedsForUnlink).not.toHaveBeenCalled()
  })
})

describe("old page's voidInvoice — bank feed release", () => {
  it("releases an unconfirmed matched feed back to unmatched", async () => {
    mockFeedsSelect.mockResolvedValue({ data: [{ id: "feed-1", status: "matched" }], error: null })
    mockPartitionFeedsForUnlink.mockReturnValue({ resetIds: ["feed-1"], clearIds: [] })
    await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(mockFeedsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ matched_payment_id: null, status: "unmatched" }),
    )
  })

  it("keeps a CONFIRMED transaction's link — excludes it from what gets released (money stays attributed correctly)", async () => {
    mockFeedsSelect.mockResolvedValue({ data: [{ id: "feed-1", status: "matched" }], error: null })
    mockListConfirmedApplications.mockResolvedValue([{ amount: 500, feed_id: "feed-1" }])
    await voidInvoice(PAYMENT_ID, "2026-01-01T00:00:00Z")
    // partitionFeedsForUnlink is called with the RELEASABLE set only — the
    // confirmed feed must already be filtered out before it's reached.
    expect(mockPartitionFeedsForUnlink).toHaveBeenCalledWith([])
  })
})
