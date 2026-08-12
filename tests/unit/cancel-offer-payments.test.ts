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
/** WS-C: invoices that carry a tranche stamp for the offer token (part 2, 3, …). */
let tranchesFixture: Array<{ id: string }> = []
let tranchesError: { message: string } | null = null
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
          in: vi.fn((col: string, ids: string[]) => {
            if (mode === "update") {
              lastUpdateIds = ids
              return Promise.resolve({ data: null, error: updateError })
            }
            // Two different SELECTs hit this table: the tranche sweep (keyed on the
            // offer token) and the state load (keyed on payment id). Routing on the
            // column keeps them apart — resolving both to the same fixture would let
            // a test pass while the code queried the wrong thing entirely.
            if (col === "tranche_offer_token") {
              return Promise.resolve({ data: tranchesFixture, error: tranchesError })
            }
            // HONOUR THE ID FILTER. Returning the whole fixture regardless of what
            // was asked for made at least one test pass vacuously: a paid part two
            // that the code never even looked up still appeared in the result, so
            // the refusal fired for the wrong reason.
            const wanted = new Set(ids)
            return Promise.resolve({
              data: paymentsError ? null : paymentsFixture.filter((p) => wanted.has(p.id)),
              error: paymentsError,
            })
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
  tranchesFixture = []
  tranchesError = null
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

// ─── WS-C: a setup fee paid in parts ─────────────────────
//
// The activation row holds ONE invoice pointer. Every part after the first is
// invisible to it, so deleting the offer used to void part one and leave part
// two live and due in the client's portal — the same orphan this file exists to
// prevent, arriving through a second door.

describe("payment plans — the parts the activation pointer cannot see", () => {
  it("cancels a later part that is linked ONLY by its tranche stamp", async () => {
    activationsFixture = [{ portal_invoice_id: "pay-part1" }]
    tranchesFixture = [{ id: "pay-part1" }, { id: "pay-part2" }]
    paymentsFixture = [
      { id: "pay-part1", invoice_number: "INV-000501", status: "Sent", invoice_status: "Sent", amount_paid: 0 },
      { id: "pay-part2", invoice_number: "INV-000502", status: "Draft", invoice_status: "Draft", amount_paid: 0 },
    ]

    const res = await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(res.ok).toBe(true)
    expect(res.cancelled).toBe(2)
    expect(lastUpdateIds).toEqual(["pay-part1", "pay-part2"])
  })

  it("MUTATION GUARD — without the tranche sweep, part two survives the cascade", async () => {
    // The same offer as above with the tranche sweep returning nothing, which is
    // exactly what the pointer-only code did. If this ever reads 2, the sweep has
    // been removed and the orphan is back.
    activationsFixture = [{ portal_invoice_id: "pay-part1" }]
    tranchesFixture = []
    paymentsFixture = [
      { id: "pay-part1", invoice_number: "INV-000501", status: "Sent", invoice_status: "Sent", amount_paid: 0 },
    ]

    const res = await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(res.cancelled).toBe(1)
    expect(lastUpdateIds).toEqual(["pay-part1"])
  })

  it("finds a part even when the activation row has no invoice pointer at all", async () => {
    // A plan whose activation row was never stamped still has its invoices findable.
    activationsFixture = []
    tranchesFixture = [{ id: "pay-part2" }]
    paymentsFixture = [
      { id: "pay-part2", invoice_number: "INV-000502", status: "Draft", invoice_status: "Draft", amount_paid: 0 },
    ]

    const res = await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(res.ok).toBe(true)
    expect(res.cancelled).toBe(1)
  })

  it("REFUSES the whole cascade when a later part has been paid", async () => {
    // Voiding part one while part two holds real money would leave the books
    // describing a deal that no longer exists. Refuse and let a person decide.
    activationsFixture = [{ portal_invoice_id: "pay-part1" }]
    tranchesFixture = [{ id: "pay-part1" }, { id: "pay-part2" }]
    paymentsFixture = [
      { id: "pay-part1", invoice_number: "INV-000501", status: "Draft", invoice_status: "Draft", amount_paid: 0 },
      { id: "pay-part2", invoice_number: "INV-000502", status: "Paid", invoice_status: "Paid", amount_paid: 1250 },
    ]

    const res = await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(0)
    expect(res.blocked_paid?.[0].invoice_number).toBe("INV-000502")
    expect(lastUpdateIds).toBeNull()
  })

  it("a FAILED tranche lookup refuses the cascade instead of half-cancelling", async () => {
    // Treating the error as "no parts found" would silently void part one and
    // strand the rest — the failure mode must be refusal, not partial success.
    activationsFixture = [{ portal_invoice_id: "pay-part1" }]
    tranchesError = { message: "connection reset" }
    paymentsFixture = [
      { id: "pay-part1", invoice_number: "INV-000501", status: "Sent", invoice_status: "Sent", amount_paid: 0 },
    ]

    const res = await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(0)
    expect(res.error).toContain("payment-plan invoice lookup failed")
    expect(lastUpdateIds).toBeNull()
  })

  it("frees the tranche idempotency key so a re-signed offer can re-mint its parts", async () => {
    activationsFixture = []
    tranchesFixture = [{ id: "pay-part2" }]
    paymentsFixture = [
      { id: "pay-part2", invoice_number: "INV-000502", status: "Draft", invoice_status: "Draft", amount_paid: 0 },
    ]

    await cancelPaymentsForOfferTokens(["mario-rossi-2026"], "dashboard:antonio")

    expect(lastUpdatePayload?.idempotency_key).toBeNull()
    expect(lastUpdatePayload?.status).toBe("Cancelled")
  })
})
