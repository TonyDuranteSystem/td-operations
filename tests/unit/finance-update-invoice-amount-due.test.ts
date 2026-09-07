/**
 * Tests for Finance's updateInvoice — specifically the amount_due
 * recalculation when the total is edited. Regression test for the bug found
 * 2026-09-06: it used to set amount_due to the new total outright, ignoring
 * any amount already paid, so editing the total on a Partial invoice erased
 * the record of the partial payment, and editing it on an already-Paid
 * invoice (this action has no status gate) reopened it as owing money again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockRevalidatePath, mockSingle, mockUpdate, mockUpdateEq, mockListConfirmedApplications } = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockListConfirmedApplications: vi.fn(),
}))

vi.mock("@/lib/finance/apply-payment", () => ({
  listConfirmedApplications: (...args: unknown[]) => mockListConfirmedApplications(...args),
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
      update: (updates: unknown) => {
        mockUpdate(updates)
        return { eq: mockUpdateEq }
      },
    })),
  },
}))

import { updateInvoice } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "inv-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateEq.mockResolvedValue({ error: null })
  mockListConfirmedApplications.mockResolvedValue([])
})

describe("updateInvoice — amount_due recalculation on total edit", () => {
  it("subtracts the already-paid amount instead of setting amount_due to the raw new total (Partial invoice)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 400 } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1000, amount_due: 600 }),
    )
  })

  it("keeps amount_due at zero instead of reopening an already fully-paid invoice", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000 } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_due: 0 }),
    )
  })

  it("never goes negative when the new total is less than what was already paid", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000 } })
    const result = await updateInvoice(PAYMENT_ID, { total: 700 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_due: 0 }),
    )
  })

  it("matches the full total when nothing has been paid yet (Draft invoice — unchanged behavior)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0 } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1250 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_due: 1250 }),
    )
  })

  it("treats a null amount_paid the same as zero", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_due: 500 }),
    )
  })

  it("does not touch amount_due at all when total isn't part of the edit", async () => {
    const result = await updateInvoice(PAYMENT_ID, { notes: "internal note only" })
    expect(result.success).toBe(true)
    expect(mockSingle).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.not.objectContaining({ amount_due: expect.anything() }),
    )
  })
})

// Regression coverage for the 3-way correction prompt (dev job ef5da377,
// Antonio-approved mockup, built 2026-09-07). Editing the total on an
// already-Paid invoice is ambiguous, so the caller (the correction prompt on
// both Finance's and the Account page's Edit dialogs) must say which of the
// three real-world cases this is.
describe("updateInvoice — correction path on an already-Paid invoice", () => {
  it("refuses to change the total on a Paid invoice with no correction path given", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1400 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already marked Paid/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("partial_payment: reopens as Partial and clears paid_date when a balance remains", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1400 }, "partial_payment")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1400,
        amount_due: 400,
        status: "Pending",
        invoice_status: "Partial",
        paid_date: null,
      }),
    )
  })

  // Regression test for the blocker found live 2026-09-07 (full council
  // review): a decrease that's still fully covered by what's already paid
  // isn't a partial payment — there's nothing left owing to reopen. This
  // used to silently leave amount_paid untouched, producing amount_paid >
  // total with no record of why. It's rejected now, pointing staff at the
  // "typo" option instead.
  it("partial_payment: refuses when the new total doesn't exceed what's already paid, instead of silently leaving amount_paid > total", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 900 }, "partial_payment")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/doesn't exceed what's already been paid/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("typo on a Paid invoice: the corrected total becomes the new amount_paid too, staying settled at 0 due — not a stale amount_paid producing Paid-with-a-balance (the live bug found 2026-09-07)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 600, status: "Paid", invoice_status: "Paid" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 850 }, "typo")
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({ total: 850, amount: 850, subtotal: 850, amount_paid: 850, amount_due: 0 }))
    expect(call.status).toBeUndefined()
    expect(call.invoice_status).toBeUndefined()
    expect(call.paid_date).toBeUndefined()
  })

  // Regression test for the major finding from live 2026-09-07 (full council
  // review): "typo" trusted the staff-entered number blindly, with no check
  // against what a real bank transaction actually confirmed — so it could
  // silently manufacture or erase real, verified cash.
  it("typo: refuses when confirmed bank payments on file don't match the corrected total", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 850, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([{ id: "a1", feed_id: "f1", amount: 850 }])
    const result = await updateInvoice(PAYMENT_ID, { total: 700 }, "typo")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/confirmed bank payments on file/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("typo: allowed when the corrected total matches the confirmed bank payments on file", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 850, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([{ id: "a1", feed_id: "f1", amount: 700 }])
    const result = await updateInvoice(PAYMENT_ID, { total: 700 }, "typo")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ amount_paid: 700 }))
  })

  it("typo: allowed with no cross-check when nothing was confirmed by a bank transaction (e.g. a manual/cash payment)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 600, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 850 }, "typo")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ amount_paid: 850 }))
  })

  it("typo on a NON-Paid invoice behaves like an ordinary edit — amount_paid untouched, balance recomputed", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 400, status: "Pending", invoice_status: "Sent" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 }, "typo")
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({ total: 1000, amount_due: 600 }))
    expect(call.amount_paid).toBeUndefined()
  })

  it("a correction path on a non-Paid invoice is simply ignored — ordinary behavior", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 400, status: "Pending", invoice_status: "Partial" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 }, "typo")
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1000, amount_due: 600 }),
    )
  })

  // Regression test for the bug found live 2026-09-07 (second bug-hunter
  // pass): a credit note's coarse `status` is ALSO always "Paid" (settled at
  // creation), but its `invoice_status` is "Credit", not "Paid". The gate
  // used to check status OR invoice_status, so editing a credit note's
  // amount threw this error unconditionally — and the matching client-side
  // check only looks at invoice_status, so the correction prompt that would
  // have supplied a path never even appeared. Only invoice_status counts now.
  it("does NOT require a correction path when status is Paid but invoice_status isn't (a credit note) — real invoices always set both together", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    const result = await updateInvoice(PAYMENT_ID, { total: -650 })
    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ total: -650 }),
    )
  })

  // Regression coverage for the blocker found live 2026-09-07 (full council
  // review, independently confirmed by 3 reviewers): correcting a credit
  // note's total never touched credit_remaining — the SEPARATE field
  // lib/operations/credit-netting.ts actually reads to auto-apply credit to
  // a client's next invoice — so a corrected note could still hand out the
  // old, wrong amount later. Whatever's already been consumed must survive
  // the correction; only the unconsumed remainder should track the new total.
  describe("updateInvoice — credit note total correction resyncs credit_remaining", () => {
    it("recomputes credit_remaining preserving what's already been consumed", async () => {
      // Note was -500, 300 still unspent → 200 already consumed elsewhere.
      mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 300 } })
      const result = await updateInvoice(PAYMENT_ID, { total: -650 })
      expect(result.success).toBe(true)
      const call = mockUpdate.mock.calls[0][0]
      // 200 already consumed; new remaining = 650 - 200 = 450.
      expect(call).toEqual(expect.objectContaining({ total: -650, amount_paid: -650, credit_remaining: 450, amount_due: 0 }))
    })

    it("tracks the new total directly when nothing has been consumed yet", async () => {
      mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
      const result = await updateInvoice(PAYMENT_ID, { total: -650 })
      expect(result.success).toBe(true)
      const call = mockUpdate.mock.calls[0][0]
      expect(call.credit_remaining).toBe(650)
      expect(call.amount_paid).toBe(-650)
    })

    it("never lets credit_remaining go negative when consumed exceeds the corrected total", async () => {
      // Note was -500, fully consumed (credit_remaining 0). Corrected down to -300.
      mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 0 } })
      const result = await updateInvoice(PAYMENT_ID, { total: -300 })
      expect(result.success).toBe(true)
      const call = mockUpdate.mock.calls[0][0]
      expect(call.credit_remaining).toBe(0)
    })
  })

  it("still requires a correction path when invoice_status is genuinely Paid, regardless of what status holds", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1400 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already marked Paid/)
  })
})

// Regression coverage for the two blockers found live 2026-09-07 (full
// council review, independently confirmed by 2+ reviewers each): the
// ordinary edit branch recomputed amount_due but never touched status at
// all, in either direction.
describe("updateInvoice — ordinary edit keeps status honest relative to the recomputed balance", () => {
  it("promotes a non-Paid invoice to Paid when the corrected total is now fully covered by what's on file", async () => {
    // Sent/Partial invoice, $600 already paid, corrected total matches it exactly.
    mockSingle.mockResolvedValue({ data: { amount_paid: 600, status: "Pending", invoice_status: "Partial" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 600 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      total: 600, amount_due: 0, status: "Paid", invoice_status: "Paid",
    }))
    expect(call.paid_date).toBeTruthy()
  })

  it("does not touch invoice_status when promoting a bare/legacy payment (null invoice_status) to Paid", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 750, status: "Pending", invoice_status: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: 750 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.status).toBe("Paid")
    expect(call.invoice_status).toBeUndefined()
  })

  it("leaves a genuinely still-open invoice alone (no promotion) when a balance remains", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 400, status: "Pending", invoice_status: "Sent" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.amount_due).toBe(600)
    expect(call.status).toBeUndefined()
    expect(call.invoice_status).toBeUndefined()
  })

  // The reverse direction: a bare/legacy payment can carry coarse
  // status='Paid' even when invoice_status disagrees or is null (the exact
  // 46-row mismatch the System Counselor found live in production). Editing
  // its amount up must not leave it labeled Paid with money owing — the
  // same Paid-with-a-balance-due bug this whole feature exists to prevent.
  it("un-marks a coarse-status-Paid bare payment as Pending when the correction creates a balance", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 500, status: "Paid", invoice_status: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: 600 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({ total: 600, amount_due: 100, status: "Pending", paid_date: null }))
    expect(call.invoice_status).toBeUndefined()
  })

  // A drifted row where the coarse status says Paid but invoice_status has
  // already diverged to something else (not 'Paid', not 'Credit') still
  // reaches the ordinary branch. invoice_status is left alone here — it
  // wasn't 'Paid' to begin with, so there's no stale "Paid" label to correct
  // on that column, and overwriting a value in a state this fix doesn't
  // fully understand is not this fix's job.
  it("un-marks the coarse status but leaves an already-diverged invoice_status untouched", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 500, status: "Paid", invoice_status: "Overdue" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 600 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.status).toBe("Pending")
    expect(call.invoice_status).toBeUndefined()
  })
})
