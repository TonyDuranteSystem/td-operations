/**
 * Unit tests for syncInvoiceStatus's optional compare-and-swap on the
 * 'payment' branch (lib/portal/unified-invoice.ts).
 *
 * Added 2026-09-09 (dev job 6aebd8c0, full 6-reviewer council review). Two
 * callers do a fresh read of invoice_status, decide what to write, then call
 * this function to write it — with nothing in between to stop a concurrent
 * payment from landing on the same invoice: the interactive due-date edit
 * (app/(dashboard)/finance/actions.ts) and the daily dunning cron's own
 * "reverse step" (lib/billing/dunning.ts unmarkFutureDatedInvoices), which is
 * the very safety net the due-date finding's "it self-heals within a day"
 * reasoning rests on — so both needed the fix, not just the interactive one.
 *
 * The fix threads an optional expectedInvoiceStatus parameter into this one
 * shared function rather than patching each call site separately, so both
 * callers (and any future one) inherit it from a single change. Omitting the
 * parameter preserves today's unconditional-write behavior exactly, for
 * every existing caller that doesn't pass it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface PaymentRow {
  invoice_status: string
  portal_invoice_id: string | null
}

let paymentFixture: PaymentRow = { invoice_status: "Overdue", portal_invoice_id: null }
// Simulates the real CAS: the guarded update only matches when the row's
// invoice_status still equals what the test says it currently is.
let currentInvoiceStatus = "Overdue"
const updateLog: Array<{ patch: Record<string, unknown>; eqs: Array<[string, unknown]> }> = []
const mockSyncTDInvoiceStatus = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payments") {
        return {
          update: (patch: Record<string, unknown>) => {
            const eqs: Array<[string, unknown]> = []
            const builder = {
              eq: (col: string, val: unknown) => {
                eqs.push([col, val])
                return builder
              },
              select: () => {
                updateLog.push({ patch, eqs: [...eqs] })
                const statusEq = eqs.find(([col]) => col === "invoice_status")
                const matched = !statusEq || statusEq[1] === currentInvoiceStatus
                return Promise.resolve({
                  data: matched ? [{ id: eqs.find(([c]) => c === "id")?.[1] }] : [],
                  error: null,
                })
              },
            }
            return builder
          },
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: paymentFixture, error: null }),
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }
    },
  },
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: (...args: unknown[]) => mockSyncTDInvoiceStatus(...args),
}))

import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"

beforeEach(() => {
  vi.clearAllMocks()
  updateLog.length = 0
  paymentFixture = { invoice_status: "Overdue", portal_invoice_id: null }
  currentInvoiceStatus = "Overdue"
})

describe("syncInvoiceStatus — optional compare-and-swap", () => {
  it("writes normally and reports synced:true when no expectedInvoiceStatus is passed (existing callers unaffected)", async () => {
    const result = await syncInvoiceStatus("payment", "pay-1", "Sent")
    expect(result.synced).toBe(true)
    expect(updateLog[0].eqs.some(([col]) => col === "invoice_status")).toBe(false)
  })

  it("writes and reports synced:true when the expected status still matches", async () => {
    currentInvoiceStatus = "Overdue"
    const result = await syncInvoiceStatus("payment", "pay-1", "Sent", undefined, undefined, "Overdue")
    expect(result.synced).toBe(true)
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalled()
  })

  // The core fix: a concurrent payment moved invoice_status to 'Partial' in
  // between the caller's read and this call — the guarded write matches zero
  // rows, and the function must report that honestly instead of running the
  // mirror sync on a flip that never happened.
  it("refuses and skips the mirror sync when the invoice no longer matches the expected status", async () => {
    currentInvoiceStatus = "Partial" // a payment landed since the caller's own read
    const result = await syncInvoiceStatus("payment", "pay-1", "Sent", undefined, undefined, "Overdue")
    expect(result.synced).toBe(false)
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
  })

  it("includes the expected-status precondition in the same update statement as the id filter", async () => {
    await syncInvoiceStatus("payment", "pay-1", "Sent", undefined, undefined, "Overdue")
    expect(updateLog[0].eqs).toEqual(
      expect.arrayContaining([
        ["id", "pay-1"],
        ["invoice_status", "Overdue"],
      ]),
    )
  })
})
