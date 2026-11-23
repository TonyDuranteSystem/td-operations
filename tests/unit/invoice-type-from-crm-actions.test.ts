/**
 * One-off invoices save NOTHING hidden; an installment is saved exactly as the CRM's Installments section sent it
 * (dev job bea928e0, Antonio 2026-11-22).
 *
 * Break "no Payment Type, no hidden code, no year on a one-off" and the first two blocks fail; go back to guessing the
 * year from the issue date and the New Year case fails (an installment for 2026 issued on 5 Jan 2027 must stay 2026);
 * drop the system key and the key cases fail (a manual installment would be billed next to the system-made one);
 * overwrite an invoice that already existed and the last block fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCreateTDInvoice, paymentUpdates, mockPaidSteps } = vi.hoisted(() => ({
  mockCreateTDInvoice: vi.fn(),
  paymentUpdates: [] as Array<Record<string, unknown>>,
  mockPaidSteps: vi.fn(),
}))

vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: mockCreateTDInvoice }))
vi.mock("@/lib/billing/run-installment-paid-steps", () => ({ runInstallmentPaidSteps: mockPaidSteps }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        paymentUpdates.push(patch)
        return { eq: async () => ({ error: null }) }
      },
    }),
  }),
}))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/operations/credit-netting", () => ({ applyAvailableCreditToInvoice: vi.fn() }))
vi.mock("@/lib/offers/payment-plan-state", () => ({ resolveTrancheCardFeeRate: vi.fn() }))
vi.mock("@/lib/invoice-auto-send", () => ({ fetchSettingsBanks: vi.fn(async () => []), selectSettingsBank: vi.fn(() => null) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<unknown>) => {
    try {
      return { success: true, data: await fn() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }),
}))

import { createInvoice, createCreditNote } from "@/app/(dashboard)/shared/invoice-actions"
import { createUnifiedInvoiceDraft } from "@/app/(dashboard)/finance/actions"

const ACCT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const item = { description: "Shipping Service", quantity: 1, unit_price: 100, amount: 100, sort_order: 0 }
const oneOff = { account_id: ACCT, description: "Shipping Service", amount_currency: "USD" as const, issue_date: "2026-11-22", discount: 0, items: [item] }

beforeEach(() => {
  mockCreateTDInvoice.mockReset()
  mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-1", expenseId: "exp-1", invoiceNumber: "INV-000001", total: 100, status: "Draft" })
  paymentUpdates.length = 0
  mockPaidSteps.mockReset()
  mockPaidSteps.mockResolvedValue({ ran: true, failedSteps: [] })
})

const lastCall = () => mockCreateTDInvoice.mock.calls[mockCreateTDInvoice.mock.calls.length - 1][0] as Record<string, unknown>

describe("a one-off invoice from the CRM window saves nothing hidden", () => {
  it("sends no Payment Type and no year, and uses the ordinary content key", async () => {
    const res = await createInvoice(oneOff)
    expect(res.success).toBe(true)
    const call = lastCall()
    expect(call.installment).toBeUndefined()
    expect(call.year).toBeUndefined()
    expect(call).not.toHaveProperty("payment_category")
    expect(String(call.idempotency_key)).toMatch(/^manual-crm-invoice:/)
  })

  it("the Finance one-off draft sends no Payment Type and no year either — even if a caller still tries", async () => {
    const res = await createUnifiedInvoiceDraft({
      account_id: ACCT,
      description: "Shipping Service",
      currency: "USD",
      items: [item],
      // an old caller / a hand-built request: these must NOT reach the invoice
      ...({ installment: "One-Time Service", year: 2026 } as Record<string, unknown>),
    })
    expect(res.success).toBe(true)
    const call = lastCall()
    expect(call.installment).toBeUndefined()
    expect(call.year).toBeUndefined()
  })
})

describe("an installment from the Installments section is saved exactly as sent", () => {
  it("January: label + its year + the contract-signing key", async () => {
    const res = await createInvoice({ ...oneOff, description: "1st Installment 2026", installment: "Installment 1 (Jan)", year: 2026 })
    expect(res.success).toBe(true)
    const call = lastCall()
    expect(call.installment).toBe("Installment 1 (Jan)")
    expect(call.year).toBe(2026)
    expect(call.idempotency_key).toBe(`renewal-1st:${ACCT}:2026`)
  })

  it("June: label + its year + the yearly-run key", async () => {
    await createInvoice({ ...oneOff, description: "2nd Installment 2026", installment: "Installment 2 (Jun)", year: 2026 })
    const call = lastCall()
    expect(call.installment).toBe("Installment 2 (Jun)")
    expect(call.year).toBe(2026)
    expect(call.idempotency_key).toBe(`annual-installment:${ACCT}:2:2026`)
  })

  it("New Year: an installment for 2026 issued on 5 January 2027 stays year 2026 (it used to become 2027)", async () => {
    await createInvoice({ ...oneOff, issue_date: "2027-01-05", installment: "Installment 1 (Jan)", year: 2026 })
    expect(lastCall().year).toBe(2026)
  })

  it("a label without its year is refused and nothing is created", async () => {
    const res = await createInvoice({ ...oneOff, installment: "Installment 1 (Jan)" })
    expect(res.success).toBe(false)
    expect(mockCreateTDInvoice).not.toHaveBeenCalled()
  })

  it("an old one-off label is refused and nothing is created", async () => {
    const res = await createInvoice({ ...oneOff, installment: "Setup Fee" as never, year: 2026 })
    expect(res.success).toBe(false)
    expect(mockCreateTDInvoice).not.toHaveBeenCalled()
  })
})

describe("an invoice that already existed is returned untouched and says so", () => {
  it("does not overwrite the existing invoice's description or payer, and the warning names it", async () => {
    mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-old", expenseId: "exp-old", invoiceNumber: "INV-000777", total: 1000, status: "Draft", alreadyExisted: true })
    const res = await createInvoice({ ...oneOff, description: "1st Installment 2026", installment: "Installment 1 (Jan)", year: 2026 })
    expect(res.success).toBe(true)
    expect(paymentUpdates).toHaveLength(0)
    expect((res as { data: { duplicate_warning?: string } }).data.duplicate_warning).toMatch(/INV-000777.*nothing new was created/)
  })

  it("a brand-new invoice still gets its description + payer written as before", async () => {
    await createInvoice(oneOff)
    expect(paymentUpdates).toHaveLength(1)
    expect(paymentUpdates[0]).toMatchObject({ description: "Shipping Service" })
    expect((paymentUpdates[0] as Record<string, unknown>)).not.toHaveProperty("already_existed")
  })

  it("tells the window nothing was created (so it never sends it, marks it paid or says 'created')", async () => {
    mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-old", expenseId: "exp-old", invoiceNumber: "INV-000777", total: 1000, status: "Sent", alreadyExisted: true })
    const res = await createInvoice({ ...oneOff, mark_as_paid: true })
    expect((res as { data: { already_existed?: boolean } }).data.already_existed).toBe(true)
  })

  it("a brand-new invoice does not carry the 'already existed' flag", async () => {
    const res = await createInvoice(oneOff)
    expect((res as { data: { already_existed?: boolean } }).data.already_existed).toBeUndefined()
  })
})

describe("an installment the client's credit covered completely runs the yearly steps (it is born Paid, nobody marks it paid later)", () => {
  const jan = { ...oneOff, description: "1st Installment 2026", installment: "Installment 1 (Jan)" as const, year: 2026 }
  const june = { ...oneOff, description: "2nd Installment 2026", installment: "Installment 2 (Jun)" as const, year: 2026 }
  const born = (status: string, extra: Record<string, unknown> = {}) =>
    mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-1", expenseId: "exp-1", invoiceNumber: "INV-000001", total: 0, status, ...extra })

  it("born Paid → the steps run once, for that company, label and year, and there is no warning", async () => {
    born("Paid")
    const res = await createInvoice(jan)
    expect(res.success).toBe(true)
    expect(mockPaidSteps).toHaveBeenCalledTimes(1)
    expect(mockPaidSteps).toHaveBeenCalledWith({ accountId: ACCT, installment: "Installment 1 (Jan)", year: 2026 })
    expect((res as { data: { duplicate_warning?: string } }).data.duplicate_warning).toBeUndefined()
  })

  it("the June installment runs its own steps too", async () => {
    born("Paid")
    await createInvoice(june)
    expect(mockPaidSteps).toHaveBeenCalledWith({ accountId: ACCT, installment: "Installment 2 (Jun)", year: 2026 })
  })

  it("an installment that is still a Draft runs nothing (the steps start when it is really paid)", async () => {
    born("Draft")
    await createInvoice(jan)
    expect(mockPaidSteps).not.toHaveBeenCalled()
  })

  it("an invoice that already existed runs nothing, even if it is Paid", async () => {
    born("Paid", { alreadyExisted: true })
    await createInvoice(jan)
    expect(mockPaidSteps).not.toHaveBeenCalled()
  })

  it("a one-off invoice marked paid is not an installment: nothing runs", async () => {
    born("Paid")
    await createInvoice({ ...oneOff, mark_as_paid: true })
    expect(mockPaidSteps).not.toHaveBeenCalled()
  })

  it("a step that reports a problem is shown to the staff member, never swallowed", async () => {
    born("Paid")
    mockPaidSteps.mockResolvedValue({ ran: true, failedSteps: ["recurring_services"] })
    const res = await createInvoice(jan)
    expect(res.success).toBe(true)
    expect((res as { data: { duplicate_warning?: string } }).data.duplicate_warning).toMatch(/already paid.*recurring_services/)
  })

  it("steps that crash do not undo the invoice — it is still created, with a plain warning", async () => {
    born("Paid")
    mockPaidSteps.mockRejectedValue(new Error("boom"))
    const res = await createInvoice(jan)
    expect(res.success).toBe(true)
    expect((res as { data: { id: string; duplicate_warning?: string } }).data.id).toBe("pay-1")
    expect((res as { data: { duplicate_warning?: string } }).data.duplicate_warning).toMatch(/did not run/)
  })
})

describe("a credit note that already existed is returned untouched (spent credit must not become spendable again)", () => {
  // Only reachable in the short window between the credit note being inserted and being marked as a credit: the key lookup
  // skips finished credit notes (they are 'Credit'), so a LATER re-submit of the same credit note is stopped by the database
  // index instead — the same raw error as before this job, with no second credit written.
  const note ={ account_id: ACCT, description: "Referral credit", amount_currency: "USD" as const, issue_date: "2026-11-22", items: [{ description: "Referral credit", quantity: 1, unit_price: 100, amount: 100, sort_order: 0 }] }

  it("a NEW credit note is written as a credit with its full remaining amount", async () => {
    await createCreditNote(note)
    expect(paymentUpdates).toHaveLength(1)
    expect(paymentUpdates[0]).toMatchObject({ invoice_status: "Credit", credit_remaining: 100 })
  })

  it("an EXISTING credit note is not rewritten (credit_remaining stays as it is)", async () => {
    mockCreateTDInvoice.mockResolvedValue({ paymentId: "cn-old", expenseId: "exp-old", invoiceNumber: "CN-000010", total: -100, status: "Credit", alreadyExisted: true })
    const res = await createCreditNote(note)
    expect(res.success).toBe(true)
    expect(paymentUpdates).toHaveLength(0)
  })
})
