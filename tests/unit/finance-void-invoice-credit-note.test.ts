/**
 * Tests for Finance's voidInvoice (app/(dashboard)/finance/actions.ts).
 *
 * First describe block: regression test for the minor finding from live
 * 2026-09-07 (full second-round council review, Bug-Hunter): voiding a
 * credit note flips its invoice_status away from 'Credit', making its
 * credit_remaining invisible to every credit-netting query (all of them
 * filter on invoice_status='Credit'). Recoverable via Reactivate, but
 * there's no reason to let it happen — a credit note isn't voided the way
 * an invoice is. This refusal happens before any downstream void machinery
 * runs, so those two tests only need to cover the initial read.
 *
 * Second describe block: regression test for the gap found during the
 * payment-board retirement's next phase (dev job ef5da377) — this write had
 * no row-count/TOCTOU check at all, unlike the sibling fix already shipped
 * on the old Payment Tracker page's own voidInvoice, and no guard against
 * voiding an already-fully-Paid invoice (the button that reaches it is
 * hidden for a Paid row, but nothing below the UI enforced it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockMaybeSingle,
  mockPaymentsUpdate,
  mockPaymentsUpdateEq,
  mockPaymentsUpdateNot,
  mockPaymentsUpdateSelect,
  mockFeedsSelect,
  mockFeedsUpdate,
  mockCapturePreVoidState,
  mockPartitionFeedsForUnlink,
  mockListConfirmedApplications,
  mockSyncTDInvoiceStatus,
  mockSyncTDInvoiceMirror,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockPaymentsUpdate: vi.fn(),
  mockPaymentsUpdateEq: vi.fn(),
  mockPaymentsUpdateNot: vi.fn(),
  mockPaymentsUpdateSelect: vi.fn(),
  mockFeedsSelect: vi.fn(),
  mockFeedsUpdate: vi.fn(),
  mockCapturePreVoidState: vi.fn(),
  mockPartitionFeedsForUnlink: vi.fn(),
  mockListConfirmedApplications: vi.fn(),
  mockSyncTDInvoiceStatus: vi.fn(),
  mockSyncTDInvoiceMirror: vi.fn(),
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

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: (...args: unknown[]) => mockSyncTDInvoiceStatus(...args),
}))

vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  syncTDInvoiceMirror: (...args: unknown[]) => mockSyncTDInvoiceMirror(...args),
}))

vi.mock("@/lib/qb-sync", () => ({
  syncVoidToQB: vi.fn().mockResolvedValue(undefined),
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
                not: (...notArgs: unknown[]) => {
                  mockPaymentsUpdateNot(...notArgs)
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

import { voidInvoice } from "@/app/(dashboard)/finance/actions"

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
  mockSyncTDInvoiceStatus.mockResolvedValue(undefined)
  mockSyncTDInvoiceMirror.mockResolvedValue({ changed: false })
})

describe("voidInvoice — credit note exclusion", () => {
  it("refuses to void a credit note", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, qb_invoice_id: null, status: "Paid", invoice_status: "Credit", amount_due: 0, amount_paid: -500, paid_date: null, credit_remaining: 300 },
    })
    const result = await voidInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credit note/)
  })

  it("still refuses an already-cancelled invoice (existing behavior, unchanged)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: PAYMENT_ID, qb_invoice_id: null, status: "Cancelled", invoice_status: "Cancelled", amount_due: 0, amount_paid: 0, paid_date: null, credit_remaining: null },
    })
    const result = await voidInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already cancelled/)
  })
})

describe("voidInvoice — TOCTOU guard on the actual write", () => {
  it("re-excludes Paid, Cancelled and Credit at the write itself, not just the earlier read", async () => {
    await voidInvoice(PAYMENT_ID)
    expect(mockPaymentsUpdateNot).toHaveBeenCalledWith("invoice_status", "in", '("Paid","Cancelled","Credit")')
  })

  // Regression coverage: a stale click (a second tab, or the bank-feed
  // auto-matcher settling the invoice between page-load and click) used to
  // match zero rows here with no check — silently falling through into the
  // bank-feed-release logic and reporting success while the payments row
  // itself was never touched.
  it("refuses and skips bank-feed release when the update matches zero rows (stale click)", async () => {
    mockPaymentsUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await voidInvoice(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/may now be Paid, already cancelled, or a credit note/)
    expect(mockFeedsSelect).not.toHaveBeenCalled()
    expect(mockPartitionFeedsForUnlink).not.toHaveBeenCalled()
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
  })

  it("proceeds through bank-feed release and the portal sync when the write genuinely matches", async () => {
    const result = await voidInvoice(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalledWith(PAYMENT_ID, "Cancelled")
    expect(mockSyncTDInvoiceMirror).toHaveBeenCalledWith(PAYMENT_ID)
  })
})

describe("voidInvoice — bank feed release", () => {
  it("releases an unconfirmed matched feed back to unmatched", async () => {
    mockFeedsSelect.mockResolvedValue({ data: [{ id: "feed-1", status: "matched" }], error: null })
    mockPartitionFeedsForUnlink.mockReturnValue({ resetIds: ["feed-1"], clearIds: [] })
    await voidInvoice(PAYMENT_ID)
    expect(mockFeedsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ matched_payment_id: null, status: "unmatched" }),
    )
  })

  it("keeps a CONFIRMED transaction's link — excludes it from what gets released (money stays attributed correctly)", async () => {
    mockFeedsSelect.mockResolvedValue({ data: [{ id: "feed-1", status: "matched" }], error: null })
    mockListConfirmedApplications.mockResolvedValue([{ amount: 500, feed_id: "feed-1" }])
    await voidInvoice(PAYMENT_ID)
    expect(mockPartitionFeedsForUnlink).toHaveBeenCalledWith([])
  })
})
