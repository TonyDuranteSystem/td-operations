/**
 * Tests for Finance's markInvoicePaid — the amount fallback for bare,
 * never-formally-invoiced payments. Regression test for the bug found
 * 2026-09-06: this action is reachable from an Account page's "Legacy
 * (pre-invoice)" section as well as from real invoices, but it only ever
 * read `total` — which a bare payment (only ever has `amount`) never sets —
 * so clicking Mark Paid on one wrote a null/zero paid amount.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockSingle,
  mockUpdate,
  mockUpdateEq,
  mockUpdateNeq,
  mockSyncTDInvoiceStatus,
  mockSyncTDInvoiceMirror,
  mockTriggerActivationIfPending,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockUpdateNeq: vi.fn(),
  mockSyncTDInvoiceStatus: vi.fn(),
  mockSyncTDInvoiceMirror: vi.fn(),
  mockTriggerActivationIfPending: vi.fn(),
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
      // Real chain: .update({...}).eq('id', paymentId).neq('status', 'Paid').
      // mockUpdateEq is called with the id (kept for existing assertions
      // that don't care about the chain shape) and returns an object whose
      // own .neq() is the one that actually resolves.
      update: (updates: unknown) => {
        mockUpdate(updates)
        return {
          eq: (...args: unknown[]) => {
            mockUpdateEq(...args)
            return { neq: mockUpdateNeq }
          },
        }
      },
    })),
  },
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: (...args: unknown[]) => mockSyncTDInvoiceStatus(...args),
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

import { markInvoicePaid } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateNeq.mockResolvedValue({ error: null })
  mockSyncTDInvoiceMirror.mockResolvedValue(undefined)
  mockTriggerActivationIfPending.mockResolvedValue(undefined)
})

describe("markInvoicePaid — bare-payment amount fallback", () => {
  it("falls back to amount when total is null (bare payment placeholder)", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: null, total: null, amount: 750, account_id: "acc-1" } })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Paid", amount_paid: 750, amount_due: 0 }),
    )
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalledWith(PAYMENT_ID, "Paid", expect.any(String), 750)
  })

  it("still uses total when it's set (real invoice — unchanged behavior)", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: "INV-1", total: 1500, amount: 1500, account_id: "acc-1" } })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_paid: 1500 }),
    )
  })

  // Regression test for the bug found live 2026-09-07 (second bug-hunter
  // pass): unlike the old page's version, this write had no status
  // precondition at all, so a stale-rendered page — the bank-feed matcher
  // settled the invoice after the page loaded, before a refresh — could
  // re-fire this and clobber the real historical paid_date with today.
  it("excludes rows already Paid from the write, so a stale-rendered page can't re-mark and clobber the real paid date", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: "INV-1", total: 1500, amount: 1500, account_id: "acc-1" } })
    await markInvoicePaid(PAYMENT_ID)
    expect(mockUpdateEq).toHaveBeenCalledWith("id", PAYMENT_ID)
    expect(mockUpdateNeq).toHaveBeenCalledWith("status", "Paid")
  })

  // Regression test for the bug found live 2026-09-07 (dev job ef5da377):
  // this button (Finance's own grid, and the Account page's row action,
  // which calls this same function) never checked whether a client's setup
  // was waiting on this invoice — only the old page's version did.
  it("checks whether a client's setup was waiting on this invoice, same as the old page's version", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: "INV-1", total: 1500, amount: 1500, account_id: "acc-1" } })
    await markInvoicePaid(PAYMENT_ID)
    expect(mockTriggerActivationIfPending).toHaveBeenCalledWith(PAYMENT_ID)
  })

  // Regression test for the blocker found live 2026-09-07 (full council
  // review): a genuinely Partial invoice has real money already on file in
  // amount_paid. This action used to overwrite it with the full total
  // unconditionally — fabricating whatever the difference was as paid. The
  // old Payment Tracker page never had this hole because its own
  // eligibility gate excluded Partial rows outright.
  it("refuses to mark Paid when the invoice already has a real partial payment on file, rather than overwriting it with the full total", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: "INV-1", total: 1500, amount: 1500, amount_paid: 1000, account_id: "acc-1" } })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already shows 1000 paid/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("still allows Mark Paid when amount_paid is 0 or null (nothing paid yet)", async () => {
    mockSingle.mockResolvedValue({ data: { id: PAYMENT_ID, invoice_number: "INV-1", total: 1500, amount: 1500, amount_paid: null, account_id: "acc-1" } })
    const result = await markInvoicePaid(PAYMENT_ID)
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ amount_paid: 1500 }))
  })
})
