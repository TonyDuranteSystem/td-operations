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
  mockUpdateSelect,
  mockTriggerActivationIfPending,
  mockSendPaidReceipt,
  mockSyncTDInvoiceStatus,
  mockSyncTDInvoiceMirror,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateIn: vi.fn(),
  mockUpdateSelect: vi.fn(),
  mockTriggerActivationIfPending: vi.fn(),
  mockSendPaidReceipt: vi.fn(),
  mockSyncTDInvoiceStatus: vi.fn(),
  mockSyncTDInvoiceMirror: vi.fn(),
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
        return {
          eq: () => ({
            in: (...args: unknown[]) => {
              mockUpdateIn(...args)
              return { select: mockUpdateSelect }
            },
          }),
        }
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

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: (...args: unknown[]) => mockSyncTDInvoiceStatus(...args),
}))

vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  syncTDInvoiceMirror: (...args: unknown[]) => mockSyncTDInvoiceMirror(...args),
}))

import { markInvoicePaid } from "@/app/(dashboard)/payments/invoice-actions"

const PAYMENT_ID = "inv-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: { total: 1200 }, error: null })
  mockUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
  mockTriggerActivationIfPending.mockResolvedValue(undefined)
  mockSendPaidReceipt.mockResolvedValue(undefined)
  mockSyncTDInvoiceStatus.mockResolvedValue(undefined)
  mockSyncTDInvoiceMirror.mockResolvedValue({ changed: false })
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

  // Regression coverage for the E2E production QA sweep (2026-09-07,
  // Bug-Hunter): the write had no row-count check at all — a stale page (the
  // bank-feed matcher settles the invoice Partial in the background before
  // the click lands) still fired a "Paid in full" receipt email and
  // activated the client's account even though nothing was actually
  // written. Mirrors the fix already shipped on Finance's own
  // markInvoicePaid.
  it("refuses and skips every side effect when the update matches zero rows (stale page)", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no longer be Sent or Overdue/)
    expect(mockSendPaidReceipt).not.toHaveBeenCalled()
    expect(mockTriggerActivationIfPending).not.toHaveBeenCalled()
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
    expect(mockSyncTDInvoiceMirror).not.toHaveBeenCalled()
  })

  it("still sends the receipt and triggers activation when the update genuinely matches", async () => {
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    // The receipt send is fire-and-forget (a dynamic import().then(), never
    // awaited by markInvoicePaid itself) — give its microtask a tick to run
    // before asserting on it, same as production doesn't wait for it either.
    await vi.waitFor(() => expect(mockSendPaidReceipt).toHaveBeenCalledWith(PAYMENT_ID))
    expect(mockTriggerActivationIfPending).toHaveBeenCalledWith(PAYMENT_ID)
  })

  // Regression coverage: this button used to never touch the client-portal
  // mirror at all, so a client marked Paid here could still see their old
  // balance after logging in (dev job ef5da377).
  it("syncs the client-portal mirror (status then balances) on a genuine Paid transition", async () => {
    const result = await markInvoicePaid(PAYMENT_ID, "2026-01-01T00:00:00Z")
    expect(result.success).toBe(true)
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalledWith(PAYMENT_ID, "Paid", expect.any(String), 1200)
    expect(mockSyncTDInvoiceMirror).toHaveBeenCalledWith(PAYMENT_ID)
  })
})
