/**
 * Regression test for the wiring gap found live in sandbox (dev job
 * 06fb1ad2): createTDInvoice correctly accepts and applies a discount, and
 * createInvoice (app/(dashboard)/shared/invoice-actions.ts) correctly threads
 * one through to it -- but the Finance page's own "New Invoice" button
 * doesn't call createInvoice at all. Both of its tabs override InvoiceDialog
 * with createUnifiedInvoiceDraft (this file), which had no `discount` field
 * on its own input type and never passed one to createTDInvoice, so a
 * discount typed on the Finance page kept doing nothing even after the
 * underlying money math was fixed. Caught by an actual click-through in
 * sandbox, not by unit tests alone -- this test exists so the wiring itself
 * is pinned going forward, not just the arithmetic.
 */
import { describe, it, expect, vi } from "vitest"

const { mockCreateTDInvoice } = vi.hoisted(() => ({
  mockCreateTDInvoice: vi.fn(async () => ({
    paymentId: "pay-1",
    expenseId: "exp-1",
    invoiceNumber: "INV-000001",
    total: 850,
    status: "Draft",
  })),
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  createTDInvoice: mockCreateTDInvoice,
}))

vi.mock("@/lib/invoice-auto-send", () => ({
  fetchSettingsBanks: vi.fn(async () => []),
  selectSettingsBank: vi.fn(() => null),
  resolveBankDetails: vi.fn(async () => ({
    accountHolder: "Tony Durante LLC",
    accountNumber: "123",
    routingNumber: "456",
    bankName: "Test Bank",
  })),
  buildPaymentInstructions: vi.fn(() => "\n\nBank Transfer:\nBeneficiary: Tony Durante LLC\nAccount: 123\nRouting: 456\nBank: Test Bank"),
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<unknown>) => {
    try {
      const data = await fn()
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }),
}))

describe("createUnifiedInvoiceDraft — discount threading (dev job 06fb1ad2)", () => {
  it("passes a real discount through to createTDInvoice", async () => {
    const { createUnifiedInvoiceDraft } = await import("@/app/(dashboard)/finance/actions")
    await createUnifiedInvoiceDraft({
      account_id: "acct-1",
      description: "Service",
      currency: "USD",
      items: [{ description: "Consulting", quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
      discount: 150,
    })

    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    const callArg = mockCreateTDInvoice.mock.calls[0][0] as { discount?: number }
    expect(callArg.discount).toBe(150)
  })

  it("passes undefined through when no discount is given -- unchanged baseline behavior", async () => {
    mockCreateTDInvoice.mockClear()
    const { createUnifiedInvoiceDraft } = await import("@/app/(dashboard)/finance/actions")
    await createUnifiedInvoiceDraft({
      account_id: "acct-1",
      description: "Service",
      currency: "USD",
      items: [{ description: "Consulting", quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
    })

    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    const callArg = mockCreateTDInvoice.mock.calls[0][0] as { discount?: number }
    expect(callArg.discount).toBeUndefined()
  })
})
