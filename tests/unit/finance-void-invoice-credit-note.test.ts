/**
 * Regression test for the minor finding from live 2026-09-07 (full
 * second-round council review, Bug-Hunter): voiding a credit note flips its
 * invoice_status away from 'Credit', making its credit_remaining invisible
 * to every credit-netting query (all of them filter on
 * invoice_status='Credit'). Recoverable via Reactivate, but there's no
 * reason to let it happen — a credit note isn't voided the way an invoice
 * is. This refusal happens before any downstream void machinery runs, so
 * the mock only needs to cover the initial read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockMaybeSingle } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mockMaybeSingle,
        })),
      })),
    })),
  },
}))

import { voidInvoice } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
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
