/**
 * Tests for Finance's updateInvoice — specifically the amount_due
 * recalculation when the total is edited. Regression test for the bug found
 * 2026-09-06: it used to set amount_due to the new total outright, ignoring
 * any amount already paid, so editing the total on a Partial invoice erased
 * the record of the partial payment, and editing it on an already-Paid
 * invoice (this action has no status gate) reopened it as owing money again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockRevalidatePath,
  mockSingle,
  mockUpdate,
  mockUpdateEq,
  mockUpdateSelect,
  mockListConfirmedApplications,
  mockAdjustSingleServiceLineForTotal,
  mockSyncClientExpenseItemsMirror,
  mockItemsSelect,
  mockItemsDelete,
  mockItemsInsert,
  mockCreditItemUpdate,
  mockCreditItemUpdateEq,
  mockNotesInsert,
} = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockUpdateSelect: vi.fn(),
  mockListConfirmedApplications: vi.fn(),
  mockAdjustSingleServiceLineForTotal: vi.fn(),
  mockSyncClientExpenseItemsMirror: vi.fn(),
  mockItemsSelect: vi.fn(),
  mockItemsDelete: vi.fn(),
  mockItemsInsert: vi.fn(),
  mockCreditItemUpdate: vi.fn(),
  mockCreditItemUpdateEq: vi.fn(),
  mockNotesInsert: vi.fn(),
}))

vi.mock("@/lib/notes/staff-notes", () => ({
  notesTable: () => ({ insert: (...args: unknown[]) => mockNotesInsert(...args) }),
}))

vi.mock("@/lib/finance/apply-payment", () => ({
  listConfirmedApplications: (...args: unknown[]) => mockListConfirmedApplications(...args),
}))

// Merged in from main (the ShoppyVerse/Growly line-item-rewrite fix): this
// test file's own focus is the money-correctness branching, not the
// line-item mechanics (that has its own dedicated, thorough test file on
// main) — mocked at the module boundary so every existing test can pass
// through it harmlessly via the beforeEach default below, rather than
// needing a realistic payment_items fixture for every single case.
vi.mock("@/lib/portal/invoice-regenerate", () => ({
  adjustSingleServiceLineForTotal: (...args: unknown[]) => mockAdjustSingleServiceLineForTotal(...args),
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
      // The line-item rewrite (merged in from main) reads/writes a SEPARATE
      // table from the `payments` row this file's own tests care about.
      if (table === "payment_items") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: mockItemsSelect,
            })),
          })),
          delete: vi.fn(() => ({
            eq: mockItemsDelete,
          })),
          insert: mockItemsInsert,
          // The credit-note direct line-item write (single row, matched by
          // id) — a separate shape from the ordinary-invoice delete+reinsert
          // above.
          update: (updates: unknown) => {
            mockCreditItemUpdate(updates)
            return { eq: mockCreditItemUpdateEq }
          },
        }
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: mockSingle,
          })),
        })),
        // Real chain: .update({...}).eq('id', paymentId)[.eq('updated_at', x)].select('id').
        // .eq() is chainable (a second .eq() only happens when the code has a
        // CAS token to guard against); .select() is always the terminal call
        // and is what actually resolves.
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

import { updateInvoice } from "@/app/(dashboard)/finance/actions"

const PAYMENT_ID = "inv-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockAdjustSingleServiceLineForTotal.mockReturnValue({ ok: true, items: [] })
  mockSyncClientExpenseItemsMirror.mockResolvedValue({ synced: true })
  mockItemsSelect.mockResolvedValue({ data: [], error: null })
  mockItemsDelete.mockResolvedValue({ error: null })
  mockItemsInsert.mockResolvedValue({ error: null })
  mockCreditItemUpdateEq.mockResolvedValue({ error: null })
  mockNotesInsert.mockResolvedValue({ error: null })
  mockUpdateEq.mockResolvedValue({ error: null })
  // Default: one row matched — the common case for every test that doesn't
  // specifically exercise the compare-and-swap guard.
  mockUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
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

    // Regression test for the MAJOR finding from live 2026-09-07 (full
    // second-round council review, Senior Engineer): correcting a credit
    // note down below what's already been consumed used to silently floor
    // credit_remaining at 0, absorbing the shortfall with no error and no
    // trace. It's refused now instead.
    it("refuses when consumed exceeds the corrected total, instead of silently absorbing the shortfall", async () => {
      // Note was -500, fully consumed (credit_remaining 0). Corrected down to -300.
      mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 0 } })
      const result = await updateInvoice(PAYMENT_ID, { total: -300 })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/already been applied to other invoices/)
      expect(mockUpdate).not.toHaveBeenCalled()
    })

    // Regression coverage for a bug caught by a second QA round on the ACTUAL
    // built code (Bug-Hunter): the consumed-vs-corrected-total comparison had
    // no rounding, unlike every sibling money comparison in this function —
    // an ordinary JS float subtraction (1000 - 300.01) lands on
    // 699.9900000000001, not the clean 699.99 a human would expect, and
    // without rounding that wrongly refused a correction that's actually
    // exact.
    it("does not wrongly refuse a correction that exactly matches consumed, despite float subtraction error", async () => {
      mockSingle.mockResolvedValue({ data: { amount_paid: -1000, status: "Paid", invoice_status: "Credit", total: -1000, credit_remaining: 300.01 } })
      const result = await updateInvoice(PAYMENT_ID, { total: -699.99 })
      expect(result.success).toBe(true)
    })

    // Regression coverage for the blocker found live 2026-09-07 (same pass,
    // AI Architect + Finance-Auditor independently): nothing re-asserted a
    // credit note's total/amount/amount_paid stay negative on a correction —
    // retyping the pre-filled negative number as a plain positive one (an
    // easy, unlabeled mistake) silently flipped the sign.
    it("forces the total/amount/amount_paid negative even when the corrected value is entered as positive", async () => {
      mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
      const result = await updateInvoice(PAYMENT_ID, { total: 650 })
      expect(result.success).toBe(true)
      const call = mockUpdate.mock.calls[0][0]
      expect(call).toEqual(expect.objectContaining({ total: -650, amount: -650, subtotal: -650, amount_paid: -650, credit_remaining: 650 }))
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
    mockSingle.mockResolvedValue({ data: { amount_paid: 600, status: "Pending", invoice_status: "Partial", invoice_number: "INV-000600" } })
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

  // Regression coverage for a bug caught by a second QA round on the ACTUAL
  // built code (Bug-Hunter): the first fix checked only `!= null` on
  // invoice_number, missing this codebase's own established fake-invoice-number
  // placeholders '1.0'/'2.0' (real production data, already special-cased the
  // same way in payment-row-actions.tsx/account-detail.tsx/contact-detail.tsx/
  // td-invoice.ts as "not really invoiced"). Promoting one of these to Paid
  // must not tag invoice_status either, or it starts appearing on the Finance
  // grid as a genuine invoice — exactly what this fix exists to prevent.
  it("does not touch invoice_status when promoting a payment whose invoice_number is the '1.0'/'2.0' fake-invoice placeholder", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 750, status: "Pending", invoice_status: null, invoice_number: "1.0" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 750 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.status).toBe("Paid")
    expect(call.invoice_status).toBeUndefined()
  })

  it("DOES tag invoice_status='Paid' for a real invoice_number", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 750, status: "Pending", invoice_status: null, invoice_number: "INV-000900" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 750 })
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.invoice_status).toBe("Paid")
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
  // ~47-row mismatch found live in production, E2E QA sweep 2026-09-07).
  // Updated same day: this row shape is now caught by wasFullyPaid itself
  // (a deliberate, later fix in the SAME pass — these rows used to bypass
  // the entire correction-path safety net when edited) — so it now
  // REQUIRES a correctionPath like any other Paid invoice, rather than
  // silently falling through to this "ordinary edit" branch's own demote
  // logic. That branch's demote logic (below) still covers the narrower
  // case where invoice_status has drifted to some OTHER non-Paid value.
  it("requires a correctionPath for a coarse-status-Paid bare/legacy payment, same as any other Paid invoice", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 500, status: "Paid", invoice_status: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: 600 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already marked Paid/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("correctly reopens a coarse-status-Paid bare/legacy payment as Partial when given a correctionPath", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 500, status: "Paid", invoice_status: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: 600 }, "partial_payment")
    expect(result.success).toBe(true)
    const call = mockUpdate.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({ total: 600, amount_due: 100, status: "Pending", invoice_status: "Partial", paid_date: null }))
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

// Regression coverage for the MAJOR finding from live 2026-09-07 (full
// second-round council review, Bug-Hunter): nothing validated the sign of a
// corrected total. A negative total on an ordinary (non-credit) invoice
// could sail through the "ordinary edit" branch, get auto-promoted to Paid
// with $0 actually recorded, and reach the client's own portal.
describe("updateInvoice — total sign validation", () => {
  it("refuses a negative total on an ordinary (non-credit) invoice", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent" } })
    const result = await updateInvoice(PAYMENT_ID, { total: -500 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/can't be negative/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("refuses a negative total even on a bare/legacy row (null invoice_status)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: null } })
    const result = await updateInvoice(PAYMENT_ID, { total: -1 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/can't be negative/)
  })

  it("still allows a negative total on a credit note", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    const result = await updateInvoice(PAYMENT_ID, { total: -300 })
    expect(result.success).toBe(true)
  })

  it("allows zero", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 0 })
    expect(result.success).toBe(true)
  })
})

// Regression coverage for the HIGH finding from live 2026-09-07 (full
// second-round council review, System Counselor + Finance-Auditor,
// independently, the latter with a concrete numeric trace of real
// Stripe-confirmed cash being silently erased): the confirmed-bank-payments
// cross-check only ever has data for wire-transfer settlements — live
// production data showed that's a small minority of Paid invoices. A card
// or Whop payment gets no protection at all without this.
describe("updateInvoice — typo refusal on card/Whop-settled invoices", () => {
  it("refuses typo on a Stripe-settled invoice with no bank-feed ledger to check against", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid", stripe_payment_id: "ch_abc123" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 100 }, "typo")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/card or Whop payment/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("refuses typo on a Whop-settled invoice the same way", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid", whop_payment_id: "whop_xyz" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 100 }, "typo")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/card or Whop payment/)
  })

  it("still allows typo when there's no stripe/whop id and no bank-feed ledger (a manual/cash payment)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 850 }, "typo")
    expect(result.success).toBe(true)
  })

  it("bank-feed check still takes precedence when both a ledger and a stripe id exist", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid", stripe_payment_id: "ch_abc123" } })
    mockListConfirmedApplications.mockResolvedValue([{ id: "a1", feed_id: "f1", amount: 1000 }])
    const result = await updateInvoice(PAYMENT_ID, { total: 1000 }, "typo")
    expect(result.success).toBe(true)
  })
})

// Regression coverage for the MEDIUM finding from live 2026-09-07 (full
// second-round council review, Finance-Auditor, with a concrete race trace):
// every sibling money-writer in this file guards its write against a stale
// read; this one didn't, so a total edit computed off a stale snapshot could
// overwrite only the fields it touched, leaving a concurrently-settled
// invoice's real amount_paid/status behind — a genuine "Paid with a balance
// due" state reached through a race instead of the branching logic.
describe("updateInvoice — compare-and-swap on the write", () => {
  it("guards the write with the row's updated_at when a total edit read it, and refuses if it changed underneath", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent", updated_at: "2026-09-07T10:00:00Z" } })
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed while you were editing/)
    expect(mockUpdateEq).toHaveBeenCalledWith("updated_at", "2026-09-07T10:00:00Z")
  })

  it("succeeds when the row is unchanged (the common case)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent", updated_at: "2026-09-07T10:00:00Z" } })
    mockUpdateSelect.mockResolvedValue({ data: [{ id: PAYMENT_ID }], error: null })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(true)
  })

  it("does not guard the write at all when the edit never touched total (no money field to race)", async () => {
    const result = await updateInvoice(PAYMENT_ID, { notes: "internal only" })
    expect(result.success).toBe(true)
    expect(mockSingle).not.toHaveBeenCalled()
    expect(mockUpdateEq).not.toHaveBeenCalledWith("updated_at", expect.anything())
  })
})

// Coverage for the line-item rewrite merged in from main 2026-09-07 (the
// 2026-08-31 ShoppyVerse/Growly fix, originally independent of every fix
// above — reconciled here after both sides touched updateInvoice while this
// branch was diverged from main for a long time). Its own money math has a
// dedicated, thorough test file on main; these tests only pin the
// INTEGRATION — that it runs with the right final number, that it's
// deliberately skipped for a credit note, and that a refusal from it
// actually blocks the save rather than partially applying.
describe("updateInvoice — line-item rewrite integration", () => {
  it("adjusts the line items using the FINAL total, not the raw input, for an ordinary edit", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(true)
    expect(mockAdjustSingleServiceLineForTotal).toHaveBeenCalledWith(expect.anything(), 500)
  })

  it("adjusts the line items using the CORRECTED (typo) total, not the pre-typo one", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 850, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 700 }, "typo")
    expect(result.success).toBe(true)
    expect(mockAdjustSingleServiceLineForTotal).toHaveBeenCalledWith(expect.anything(), 700)
  })

  it("skips the line-item rewrite entirely for a credit note", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    const result = await updateInvoice(PAYMENT_ID, { total: -650 })
    expect(result.success).toBe(true)
    expect(mockAdjustSingleServiceLineForTotal).not.toHaveBeenCalled()
    expect(mockItemsDelete).not.toHaveBeenCalled()
  })

  it("blocks the whole save when the line-item adjuster refuses (ambiguous shape), leaving the invoice untouched", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent" } })
    mockAdjustSingleServiceLineForTotal.mockReturnValue({ ok: false, items: [], reason: "More than one line makes up this invoice — edit the line items directly instead of the total alone." })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/more than one line/i)
    // The header write never runs — the refusal fires before it.
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("uses the adjusted items (not the raw current ones) for both the payment_items rewrite and the client-mirror sync", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 0, status: "Pending", invoice_status: "Sent" } })
    const adjustedItems = [{ description: "Service", quantity: 1, unit_price: 500, amount: 500, item_type: "service" }]
    mockAdjustSingleServiceLineForTotal.mockReturnValue({ ok: true, items: adjustedItems })
    const result = await updateInvoice(PAYMENT_ID, { total: 500 })
    expect(result.success).toBe(true)
    expect(mockItemsInsert).toHaveBeenCalledWith([
      expect.objectContaining({ payment_id: PAYMENT_ID, description: "Service", amount: 500, sort_order: 0 }),
    ])
    expect(mockSyncClientExpenseItemsMirror).toHaveBeenCalledWith(
      PAYMENT_ID,
      [expect.objectContaining({ description: "Service", amount: 500, sort_order: 0 })],
    )
  })
})

// Regression coverage for the E2E production QA sweep (2026-09-07): a
// corrected credit note's line items never got touched, so its
// client-downloadable PDF (items and header total sourced independently)
// permanently disagreed with itself. Deliberately NOT routed through
// adjustSingleServiceLineForTotal — see the code comment for why that
// function refuses every credit note unconditionally.
describe("updateInvoice — credit note line-item correction", () => {
  it("writes the single line item directly to match the corrected total", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    mockItemsSelect.mockResolvedValue({ data: [{ id: "item-1", description: "Referral reward", quantity: 1 }], error: null })
    const result = await updateInvoice(PAYMENT_ID, { total: -400 })
    expect(result.success).toBe(true)
    expect(mockAdjustSingleServiceLineForTotal).not.toHaveBeenCalled()
    expect(mockCreditItemUpdate).toHaveBeenCalledWith({ unit_price: -400, amount: -400 })
    expect(mockSyncClientExpenseItemsMirror).toHaveBeenCalledWith(
      PAYMENT_ID,
      [expect.objectContaining({ description: "Referral reward", quantity: 1, unit_price: -400, amount: -400, sort_order: 0 })],
    )
  })

  it("refuses (does not guess) when a credit note has more than one line item", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    mockItemsSelect.mockResolvedValue({
      data: [{ id: "item-1", description: "A", quantity: 1 }, { id: "item-2", description: "B", quantity: 1 }],
      error: null,
    })
    const result = await updateInvoice(PAYMENT_ID, { total: -400 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/more than one line item/)
    expect(mockCreditItemUpdate).not.toHaveBeenCalled()
    // The whole save is blocked — the header total is not written either.
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it("does nothing line-item-wise when a credit note has zero line items", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    mockItemsSelect.mockResolvedValue({ data: [], error: null })
    const result = await updateInvoice(PAYMENT_ID, { total: -400 })
    expect(result.success).toBe(true)
    expect(mockCreditItemUpdate).not.toHaveBeenCalled()
    expect(mockSyncClientExpenseItemsMirror).not.toHaveBeenCalled()
  })
})

// Regression coverage for the E2E production QA sweep (2026-09-07,
// Bug-Hunter): the Edit action has no status gate, and a cancelled/voided
// invoice fell into the "ordinary edit" branch, which could silently
// promote it back to Paid at a new total while amount_paid stayed at
// whatever it was before voiding.
describe("updateInvoice — refuses editing a cancelled/voided invoice", () => {
  it("refuses when status/invoice_status are the new page's 'Cancelled'/'Cancelled'", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Cancelled", invoice_status: "Cancelled" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 950 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/voided.cancelled/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("refuses when status/invoice_status are the old page's 'Waived'/'Voided'", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Waived", invoice_status: "Voided" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 950 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/voided.cancelled/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("does not refuse a credit note, even though 'Credit' is a terminal status elsewhere", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: -500, status: "Paid", invoice_status: "Credit", total: -500, credit_remaining: 500 } })
    mockItemsSelect.mockResolvedValue({ data: [{ id: "item-1", description: "Referral reward", quantity: 1 }], error: null })
    const result = await updateInvoice(PAYMENT_ID, { total: -400 })
    expect(result.success).toBe(true)
  })
})

// Regression coverage for the E2E production QA sweep (2026-09-07, Antonio's
// explicit call: flag it, don't auto-revoke). Reopening a Paid invoice as
// Partial does not pull back any portal access/services already granted —
// this is the only signal that it happened.
describe("updateInvoice — flags staff when a Paid invoice reopens as Partial", () => {
  it("creates a team-visible staff note describing what happened", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid", invoice_number: "INV-000900", account_id: "acct-1" } })
    const result = await updateInvoice(PAYMENT_ID, { total: 1400 }, "partial_payment")
    expect(result.success).toBe(true)
    expect(mockNotesInsert).toHaveBeenCalledWith(expect.objectContaining({
      visibility: "team",
      account_id: "acct-1",
      body: expect.stringContaining("INV-000900"),
    }))
  })

  it("does not flag a typo correction (nothing was actually reopened)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid" } })
    mockListConfirmedApplications.mockResolvedValue([])
    const result = await updateInvoice(PAYMENT_ID, { total: 950 }, "typo")
    expect(result.success).toBe(true)
    expect(mockNotesInsert).not.toHaveBeenCalled()
  })
})

// Regression coverage for the E2E production QA sweep (2026-09-07,
// Bug-Hunter): the paid-call-credit feature (lib/operations/paid-call-credit.ts)
// stamps a stripe_payment_id onto an invoice purely as a bank-feed matching
// key when a call is attached by hand from a real bank transaction — not
// because a card was actually charged. The original fix for the
// Finance-Auditor's mixed-payment bug must not wrongly block this case.
describe("updateInvoice — typo path distinguishes a real card charge from a matching-key stamp", () => {
  it("still refuses when bank money only PARTIALLY covers the current total (the original mixed-payment bug)", async () => {
    mockSingle.mockResolvedValue({ data: { amount_paid: 1000, status: "Paid", invoice_status: "Paid", total: 1000, stripe_payment_id: "ch_abc123" } })
    mockListConfirmedApplications.mockResolvedValue([{ amount: 400, feed_id: "feed-1" }])
    const result = await updateInvoice(PAYMENT_ID, { total: 400 }, "typo")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/card or Whop payment/)
  })

  it("allows it when confirmed bank money already fully covers the CURRENT total (paid-call-credit's matching-key case)", async () => {
    // Corrected total matches the confirmed bank sum exactly — the realistic
    // shape for this case (a typo elsewhere, e.g. the description, prompted
    // the edit; the bank-confirmed amount was always right).
    mockSingle.mockResolvedValue({ data: { amount_paid: 500, status: "Paid", invoice_status: "Paid", total: 500, stripe_payment_id: "pi_matching_key_only" } })
    mockListConfirmedApplications.mockResolvedValue([{ amount: 500, feed_id: "feed-1" }])
    const result = await updateInvoice(PAYMENT_ID, { total: 500 }, "typo")
    expect(result.success).toBe(true)
  })
})
