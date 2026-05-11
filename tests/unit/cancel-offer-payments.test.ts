/**
 * Unit tests for lib/operations/cancel-offer-payments.ts
 *
 * The helper is the cascade-cancel path invoked by delete-offer / reset-offer
 * / delete-lead before they delete the linked pending_activations row that
 * holds the only pointer from offer_token → payments.id.
 *
 * Precedent: INV-002090 / INV-002091 for Mojo Labs LLC, where the cascade
 * was missing and the client portal still showed the orphan invoice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Fixtures (mutable per test) ─────────────────────────

interface ActivationRow {
  portal_invoice_id: string | null
}
interface PaymentRow {
  id: string
  invoice_number: string | null
  status: string
  invoice_status: string
  amount_paid: number
}

let activationsFixture: ActivationRow[] = []
let activationsError: { message: string } | null = null
let paymentsFixture: PaymentRow[] = []
let paymentsError: { message: string } | null = null
let updateError: { message: string } | null = null
let lastUpdatePayload: Record<string, unknown> | null = null
let lastUpdateIds: string[] | null = null

// ─── Mock supabaseAdmin ──────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pending_activations") {
        // .select(...).in(...).not(...) → resolves to activations
        const chain: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          not: vi.fn(() =>
            Promise.resolve({ data: activationsFixture, error: activationsError }),
          ),
        }
        return chain
      }
      if (table === "payments") {
        // Two entry points share a single .in() — its resolution depends on
        // whether select() or update() was called first.
        let mode: "select" | "update" | null = null
        const chain: Record<string, unknown> = {
          select: vi.fn(() => {
            mode = "select"
            return chain
          }),
          update: vi.fn((payload: Record<string, unknown>) => {
            mode = "update"
            lastUpdatePayload = payload
            return chain
          }),
          in: vi.fn((_col: string, ids: string[]) => {
            if (mode === "update") {
              lastUpdateIds = ids
              return Promise.resolve({ data: null, error: updateError })
            }
            return Promise.resolve({ data: paymentsFixture, error: paymentsError })
          }),
        }
        return chain
      }
      return {}
    },
  },
}))

// ─── Mock collaborators ──────────────────────────────────

const mockSyncTDInvoiceStatus = vi.fn()
vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: (...args: unknown[]) => mockSyncTDInvoiceStatus(...args),
}))

const mockLogAction = vi.fn()
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
}))

// Import after mocks
import { cancelPaymentsForOfferTokens } from "@/lib/operations/cancel-offer-payments"

beforeEach(() => {
  activationsFixture = []
  activationsError = null
  paymentsFixture = []
  paymentsError = null
  updateError = null
  lastUpdatePayload = null
  lastUpdateIds = null
  mockSyncTDInvoiceStatus.mockReset()
  mockSyncTDInvoiceStatus.mockResolvedValue(undefined)
  mockLogAction.mockReset()
})

// ─── Tests ───────────────────────────────────────────────

describe("cancelPaymentsForOfferTokens", () => {
  it("returns ok with 0 cancelled when offerTokens is empty", async () => {
    const r = await cancelPaymentsForOfferTokens([], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(0)
    expect(r.payment_ids).toEqual([])
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it("returns ok with 0 cancelled when no pending_activations are linked", async () => {
    activationsFixture = []
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(0)
    expect(r.payment_ids).toEqual([])
  })

  it("returns ok with 0 cancelled when activations exist but portal_invoice_id is null on all", async () => {
    activationsFixture = [{ portal_invoice_id: null }]
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(0)
  })

  it("returns error when pending_activations lookup fails", async () => {
    activationsError = { message: "pa lookup boom" }
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/pa lookup boom/)
  })

  it("returns error when payments lookup fails", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsError = { message: "p lookup boom" }
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/p lookup boom/)
  })

  it("refuses to cancel when a linked payment has status='Paid'", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-001000", status: "Paid", invoice_status: "Paid", amount_paid: 500 },
    ]
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(0)
    expect(r.blocked_paid).toHaveLength(1)
    expect(r.blocked_paid?.[0].invoice_number).toBe("INV-001000")
    expect(r.error).toMatch(/INV-001000/)
    // Must NOT have attempted to write to payments.
    expect(lastUpdatePayload).toBeNull()
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it("refuses to cancel when a linked payment has amount_paid > 0 even if status is not 'Paid'", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-001001", status: "Partial", invoice_status: "Pending", amount_paid: 250 },
    ]
    const r = await cancelPaymentsForOfferTokens(["abc-token"], "test:actor")
    expect(r.ok).toBe(false)
    expect(r.blocked_paid?.[0].amount_paid).toBe(250)
    expect(lastUpdatePayload).toBeNull()
  })

  it("happy path — cancels a Pending payment, mirrors to expenses, logs action, NULLs the idempotency key", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-002090", status: "Pending", invoice_status: "Pending", amount_paid: 0 },
    ]

    const r = await cancelPaymentsForOfferTokens(["sanjin-token"], "dashboard:antonio")

    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(1)
    expect(r.payment_ids).toEqual(["pay-1"])

    // Verify update payload sets all 3 critical fields including idempotency_key NULL.
    expect(lastUpdatePayload).toMatchObject({
      status: "Cancelled",
      invoice_status: "Cancelled",
      idempotency_key: null,
    })
    expect(lastUpdateIds).toEqual(["pay-1"])

    // Mirror to client_expenses called for the cancelled payment.
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalledTimes(1)
    expect(mockSyncTDInvoiceStatus).toHaveBeenCalledWith("pay-1", "Cancelled")

    // action_log entry written.
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "dashboard:antonio",
        action_type: "update",
        table_name: "payments",
        record_id: "pay-1",
        summary: expect.stringContaining("INV-002090"),
      }),
    )
  })

  it("idempotent — skips payments already Cancelled and returns cancelled=0", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-002090", status: "Cancelled", invoice_status: "Cancelled", amount_paid: 0 },
    ]
    const r = await cancelPaymentsForOfferTokens(["sanjin-token"], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(0)
    expect(r.payment_ids).toEqual(["pay-1"])
    expect(lastUpdatePayload).toBeNull()
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it("returns error when the payments update fails", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-002090", status: "Pending", invoice_status: "Pending", amount_paid: 0 },
    ]
    updateError = { message: "update boom" }
    const r = await cancelPaymentsForOfferTokens(["sanjin-token"], "test:actor")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/update boom/)
    expect(r.cancelled).toBe(0)
    // No mirror or log writes when update failed.
    expect(mockSyncTDInvoiceStatus).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it("dedupes duplicate portal_invoice_id values across multiple pending_activations", async () => {
    activationsFixture = [
      { portal_invoice_id: "pay-1" },
      { portal_invoice_id: "pay-1" },
    ]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-002090", status: "Pending", invoice_status: "Pending", amount_paid: 0 },
    ]
    const r = await cancelPaymentsForOfferTokens(["sanjin-token"], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(1)
    expect(lastUpdateIds).toEqual(["pay-1"])
    expect(mockLogAction).toHaveBeenCalledTimes(1)
  })

  it("continues cancelling even when the client_expenses mirror sync throws (non-blocking)", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-1" }]
    paymentsFixture = [
      { id: "pay-1", invoice_number: "INV-002090", status: "Pending", invoice_status: "Pending", amount_paid: 0 },
    ]
    mockSyncTDInvoiceStatus.mockRejectedValueOnce(new Error("mirror boom"))
    const r = await cancelPaymentsForOfferTokens(["sanjin-token"], "test:actor")
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBe(1)
    expect(mockLogAction).toHaveBeenCalledTimes(1)
  })
})
