/**
 * Unit tests for applyMoneyToInvoice's currency guard (lib/finance/apply-payment.ts).
 *
 * Added 2026-09-09 (dev job b43aba4c, full 6-reviewer council review). The
 * automatic bank-feed matcher has always filtered candidates by currency
 * before reaching this writer; every OTHER caller — manual single-invoice
 * matching, and manual multi-invoice matching's own per-allocation loop —
 * had no equivalent check, so a EUR wire could be credited 1:1 against a
 * USD invoice (a real production incident, 2026-07-20, INV-002191) with the
 * exchange-rate gap silently absorbed as an invisible loss.
 *
 * The guard lives in applyMoneyToInvoice itself, gated on `feedId` being
 * present, so every current and future caller inherits it for free —
 * confirmPayment / markInvoicePaid never pass a feedId and are unaffected;
 * manualMatch and manualMatchMulti's waterfall loop both pass feedId through
 * settleInvoiceFromFeed and are covered by this one guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface PaymentFixture {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
  total: number | null
  amount: number | null
  amount_paid: number | null
  amount_currency: string | null
  portal_invoice_id: string | null
  account_id: string | null
  contact_id: string | null
}

let paymentFixture: PaymentFixture | null = null
let feedFixture: { currency: string } | null = null
const updateLog: Array<{ table: string; patch: Record<string, unknown> }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payments") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: paymentFixture, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            updateLog.push({ table, patch })
            return {
              eq: () => ({
                eq: () => ({ select: () => Promise.resolve({ data: [{ id: paymentFixture?.id }], error: null }) }),
                is: () => ({ select: () => Promise.resolve({ data: [{ id: paymentFixture?.id }], error: null }) }),
              }),
            }
          },
        }
      }
      if (table === "td_bank_feeds") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: feedFixture, error: null }),
            }),
          }),
        }
      }
      // payment_applications and any other incidental table this path may touch.
      return {
        select: () => ({ eq: () => ({ eq: () => ({ not: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: "claim-1" }, error: null }),
          }),
        }),
        update: () => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) }),
      }
    },
  },
}))

vi.mock("@/lib/system-errors", () => ({
  reportSystemError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/billing/invoice-reactivate", () => ({
  capturePreVoidState: vi.fn(),
  resolveReactivateTarget: vi.fn(),
}))

vi.mock("@/lib/finance/reversal-side-effects", () => ({
  describeReversalSideEffects: vi.fn(),
  resolveTargetTaxYear: vi.fn(),
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: vi.fn().mockResolvedValue(undefined),
}))

import { applyMoneyToInvoice } from "@/lib/finance/apply-payment"

const basePayment: PaymentFixture = {
  id: "pay-1",
  invoice_number: "INV-9001",
  invoice_status: "Sent",
  status: "Pending",
  total: 1000,
  amount: 1000,
  amount_paid: 0,
  amount_currency: "EUR",
  portal_invoice_id: null,
  account_id: "acc-1",
  contact_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  updateLog.length = 0
  paymentFixture = { ...basePayment }
  feedFixture = { currency: "EUR" }
})

describe("applyMoneyToInvoice — currency guard", () => {
  it("refuses a mismatched currency when feedId is present (the July INV-002191 scenario)", async () => {
    feedFixture = { currency: "USD" }
    const result = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "apply",
      appliedAmount: 1000,
      paidDate: "2026-09-09",
      actor: "bank-feed:staff",
      feedId: "feed-1",
    })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe("currency_mismatch")
    expect(result.detail).toMatch(/USD.*EUR|EUR.*USD/)
    expect(updateLog.filter((u) => u.table === "payments")).toHaveLength(0)
  })

  it("allows a matching currency to proceed", async () => {
    feedFixture = { currency: "EUR" }
    const result = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "apply",
      appliedAmount: 1000,
      paidDate: "2026-09-09",
      actor: "bank-feed:staff",
      feedId: "feed-1",
    })
    expect(result.applied).toBe(true)
  })

  it("defaults a null invoice currency to USD, matching the rest of the codebase's convention", async () => {
    paymentFixture = { ...basePayment, amount_currency: null }
    feedFixture = { currency: "USD" }
    const result = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "apply",
      appliedAmount: 1000,
      paidDate: "2026-09-09",
      actor: "bank-feed:staff",
      feedId: "feed-1",
    })
    expect(result.applied).toBe(true)

    feedFixture = { currency: "EUR" }
    const mismatch = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "apply",
      appliedAmount: 1000,
      paidDate: "2026-09-09",
      actor: "bank-feed:staff",
      feedId: "feed-1",
    })
    expect(mismatch.applied).toBe(false)
    expect(mismatch.reason).toBe("currency_mismatch")
  })

  it("does not run the currency check at all when no feedId is passed (confirmPayment / markInvoicePaid)", async () => {
    // Same EUR invoice, but a caller like markInvoicePaid never has a bank
    // transaction currency to compare against — the guard must not fire.
    feedFixture = { currency: "USD" } // would mismatch if the guard ran unconditionally
    const result = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "settle_full",
      paidDate: "2026-09-09",
      actor: "finance:mark-paid",
    })
    expect(result.applied).toBe(true)
  })

  it("fails open (does not block) when the feed's own currency can't be looked up", async () => {
    feedFixture = null
    const result = await applyMoneyToInvoice({
      paymentId: "pay-1",
      mode: "apply",
      appliedAmount: 1000,
      paidDate: "2026-09-09",
      actor: "bank-feed:staff",
      feedId: "feed-missing",
    })
    expect(result.applied).toBe(true)
  })
})
