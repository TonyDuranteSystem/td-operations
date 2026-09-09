/**
 * Tests for updateInvoiceItems — the Draft-only line-item editor rebuilt for
 * Finance (dev job ef5da377), replacing the old Payment Tracker page's
 * version. Covers the three real gaps that version had (no row-count check
 * on the header write, an unchecked line-item delete, no portal-mirror
 * sync) plus the server-side total recompute and the payment-plan guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockSingle,
  mockUpdate,
  mockUpdateEq,
  mockUpdateSelect,
  mockItemsDelete,
  mockItemsInsert,
  mockSyncClientExpenseItemsMirror,
  mockOffersMaybeSingle,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockUpdateSelect: vi.fn(),
  mockItemsDelete: vi.fn(),
  mockItemsInsert: vi.fn(),
  mockSyncClientExpenseItemsMirror: vi.fn(),
  mockOffersMaybeSingle: vi.fn(),
}))

vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  syncClientExpenseItemsMirror: (...args: unknown[]) => mockSyncClientExpenseItemsMirror(...args),
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
    from: vi.fn((table: string) => {
      if (table === "payment_items") {
        return {
          delete: vi.fn(() => ({ eq: mockItemsDelete })),
          insert: mockItemsInsert,
        }
      }
      if (table === "offers") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockOffersMaybeSingle })) })),
        }
      }
      // payments — real chain: .update({...}).eq('id',...).eq('invoice_status','Draft')
      // .eq('updated_at', lock).select('id'); .eq() is chainable, .select() is terminal.
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })),
        update: (updates: unknown) => {
          mockUpdate(updates)
          const chain = {
            eq: (...args: unknown[]) => {
              mockUpdateEq(...args)
              return chain
            },
            select: (...args: unknown[]) => mockUpdateSelect(...args),
          }
          return chain
        },
      }
    }),
  },
}))

// createInvoice lives in the same module file — importing updateInvoiceItems
// loads the whole module, but only updateInvoiceItems is exercised here.
import { updateInvoiceItems } from "@/app/(dashboard)/shared/invoice-actions"

const PAYMENT_ID = "inv-1"
const DRAFT_ROW = { invoice_status: "Draft", amount_currency: "USD", tranche_offer_token: null, tranche_seq: null }
// Deliberately wrong `amount` on the input — the server must never trust it.
const ONE_ITEM = [{ description: "Service", quantity: 1, unit_price: 100, amount: 999999 }]

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: DRAFT_ROW })
  mockUpdateEq.mockResolvedValue({ error: null })
  mockUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
  mockItemsDelete.mockResolvedValue({ error: null })
  mockItemsInsert.mockResolvedValue({ error: null })
  mockSyncClientExpenseItemsMirror.mockResolvedValue({ synced: true })
})

describe("updateInvoiceItems — status gate", () => {
  it("refuses on a non-Draft invoice", async () => {
    mockSingle.mockResolvedValue({ data: { ...DRAFT_ROW, invoice_status: "Sent" } })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Draft/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("refuses when the invoice no longer exists", async () => {
    mockSingle.mockResolvedValue({ data: null })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it("refuses with no items, without touching the database at all", async () => {
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: [] })
    expect(result.success).toBe(false)
    expect(mockSingle).not.toHaveBeenCalled()
  })
})

describe("updateInvoiceItems — server-side recompute (never trusts a client-submitted amount)", () => {
  it("ignores the caller's amount and recomputes from quantity * unit_price", async () => {
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ total: 100, subtotal: 100, amount: 100 }))
    expect(mockItemsInsert).toHaveBeenCalledWith([
      expect.objectContaining({ amount: 100, item_type: "service" }),
    ])
  })

  it("floors the total at 0 when the discount exceeds the subtotal", async () => {
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 500, items: ONE_ITEM })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ total: 0 }))
  })
})

describe("updateInvoiceItems — row-count check + optimistic lock (dev job ef5da377)", () => {
  it("refuses when the header write matches zero rows, and never touches line items", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await updateInvoiceItems(PAYMENT_ID, "stale-token", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since you opened it/)
    expect(mockItemsDelete).not.toHaveBeenCalled()
    expect(mockItemsInsert).not.toHaveBeenCalled()
  })

  it("passes the caller's updated_at as a compare-and-swap condition on the write", async () => {
    await updateInvoiceItems(PAYMENT_ID, "the-lock-token", { discount: 0, items: ONE_ITEM })
    expect(mockUpdateEq).toHaveBeenCalledWith("updated_at", "the-lock-token")
  })
})

describe("updateInvoiceItems — checked delete (dev job ef5da377)", () => {
  it("refuses and never inserts when the old line items fail to delete, and says the total already saved", async () => {
    mockItemsDelete.mockResolvedValue({ error: { message: "boom" } })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    // The header write already committed by this point — the message must
    // say so honestly rather than claim nothing changed (bug-hunter pass).
    expect(result.error).toMatch(/total saved/)
    expect(result.error).toMatch(/no longer match/)
    expect(mockItemsInsert).not.toHaveBeenCalled()
  })

  it("says the invoice now has no line items at all when the insert fails after a successful delete", async () => {
    mockItemsInsert.mockResolvedValue({ error: { message: "boom" } })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no line items at all/)
  })
})

describe("updateInvoiceItems — negative discount (dev job ef5da377, bug-hunter pass)", () => {
  it("floors a negative discount at 0 instead of letting it inflate the total past the line-item sum", async () => {
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: -50, items: ONE_ITEM })
    expect(result.success).toBe(true)
    // ONE_ITEM recomputes to 100 — a -50 "discount" must never push total to 150.
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ total: 100, discount: 0 }))
  })

  it("persists the floored discount, not the raw negative input", async () => {
    await updateInvoiceItems(PAYMENT_ID, "x", { discount: -1, items: ONE_ITEM })
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ discount: 0 }))
  })
})

describe("updateInvoiceItems — portal-mirror sync (dev job ef5da377)", () => {
  it("syncs the recomputed items to the client-portal mirror", async () => {
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(true)
    expect(mockSyncClientExpenseItemsMirror).toHaveBeenCalledWith(
      PAYMENT_ID,
      [expect.objectContaining({ description: "Service", amount: 100 })],
    )
  })
})

describe("updateInvoiceItems — payment-plan tranche guard", () => {
  const TRANCHE_ROW = { ...DRAFT_ROW, tranche_offer_token: "tok1", tranche_seq: 2 }

  it("refuses a discount on a plan-part invoice", async () => {
    mockSingle.mockResolvedValue({ data: TRANCHE_ROW })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 10, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot carry a separate discount/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // validatePaymentPlan refuses a plan whose seq numbers aren't contiguous
  // from 1, so every plan fixture below carries both parts even though only
  // part 2 is under test.
  const PART_1 = { seq: 1, amount: 50, currency: "USD", trigger: { kind: "manual" } }

  it("refuses when the new total no longer matches the plan's agreed part amount", async () => {
    mockSingle.mockResolvedValue({ data: TRANCHE_ROW })
    mockOffersMaybeSingle.mockResolvedValue({
      data: { payment_plan: [PART_1, { seq: 2, amount: 500, currency: "USD", trigger: { kind: "manual" } }] },
    })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM }) // recomputes to 100
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/agreed at 500/)
  })

  it("refuses when the invoice's currency no longer matches the plan's", async () => {
    // TRANCHE_ROW's invoice is USD; the whole plan (both parts, one currency —
    // validatePaymentPlan refuses a mixed-currency plan) is EUR, so this is a
    // invoice-vs-plan mismatch, not a mismatch within the plan itself.
    mockSingle.mockResolvedValue({ data: TRANCHE_ROW })
    mockOffersMaybeSingle.mockResolvedValue({
      data: {
        payment_plan: [
          { seq: 1, amount: 50, currency: "EUR", trigger: { kind: "manual" } },
          { seq: 2, amount: 100, currency: "EUR", trigger: { kind: "manual" } },
        ],
      },
    })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/agreed in EUR/)
  })

  it("allows a plan-part edit that still matches the agreed amount and currency", async () => {
    mockSingle.mockResolvedValue({ data: TRANCHE_ROW })
    mockOffersMaybeSingle.mockResolvedValue({
      data: { payment_plan: [PART_1, { seq: 2, amount: 100, currency: "USD", trigger: { kind: "manual" } }] },
    })
    const result = await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(result.success).toBe(true)
  })

  it("does not run the plan lookup at all for an ordinary (non-tranche) invoice", async () => {
    await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(mockOffersMaybeSingle).not.toHaveBeenCalled()
  })
})

describe("updateInvoiceItems — revalidation", () => {
  it("revalidates both the old page and Finance while the old page still exists", async () => {
    await updateInvoiceItems(PAYMENT_ID, "x", { discount: 0, items: ONE_ITEM })
    expect(mockRevalidatePath).toHaveBeenCalledWith("/payments")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/finance")
  })
})
