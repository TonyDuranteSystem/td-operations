/**
 * Tests for deleteClientExpenseMirror — the shared cleanup step that both
 * deleteInvoice (old Payment Tracker page) and deletePayment (Finance /
 * Account page) must run before a payments row can be deleted. Regression
 * coverage for the bug found 2026-09-06 (dev job ef5da377): deletePayment
 * deleted client_expenses directly, without first clearing its own
 * client_expense_items — that FK does not cascade, so the delete failed
 * every time an invoice had recorded line items, live on sandbox.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockSelectEq,
  mockItemsDeleteIn,
  mockDocsDeleteIn,
  mockExpensesDeleteEq,
} = vi.hoisted(() => ({
  mockSelectEq: vi.fn(),
  mockItemsDeleteIn: vi.fn(),
  mockDocsDeleteIn: vi.fn(),
  mockExpensesDeleteEq: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "client_expenses") {
        return {
          select: vi.fn(() => ({ eq: mockSelectEq })),
          delete: vi.fn(() => ({ eq: mockExpensesDeleteEq })),
        }
      }
      if (table === "client_expense_items") {
        return { delete: vi.fn(() => ({ in: mockItemsDeleteIn })) }
      }
      if (table === "client_invoice_documents") {
        return { delete: vi.fn(() => ({ in: mockDocsDeleteIn })) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  },
}))

import { deleteClientExpenseMirror } from "@/lib/portal/td-invoice-mirror"

const PAYMENT_ID = "pay-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockItemsDeleteIn.mockResolvedValue({ error: null })
  mockDocsDeleteIn.mockResolvedValue({ error: null })
  mockExpensesDeleteEq.mockResolvedValue({ error: null })
})

describe("deleteClientExpenseMirror", () => {
  it("no-ops when the payment was never invoiced (no mirror row)", async () => {
    mockSelectEq.mockResolvedValue({ data: [], error: null })
    await deleteClientExpenseMirror(PAYMENT_ID)
    expect(mockItemsDeleteIn).not.toHaveBeenCalled()
    expect(mockDocsDeleteIn).not.toHaveBeenCalled()
    expect(mockExpensesDeleteEq).not.toHaveBeenCalled()
  })

  it("deletes line items, then documents, then the mirror itself, in that order, when a mirror exists", async () => {
    mockSelectEq.mockResolvedValue({ data: [{ id: "expense-1" }], error: null })
    await deleteClientExpenseMirror(PAYMENT_ID)
    expect(mockItemsDeleteIn).toHaveBeenCalledWith("expense_id", ["expense-1"])
    expect(mockDocsDeleteIn).toHaveBeenCalledWith("expense_id", ["expense-1"])
    expect(mockExpensesDeleteEq).toHaveBeenCalledWith("td_payment_id", PAYMENT_ID)
  })

  it("passes every mirror row's id when more than one exists", async () => {
    mockSelectEq.mockResolvedValue({ data: [{ id: "expense-1" }, { id: "expense-2" }], error: null })
    await deleteClientExpenseMirror(PAYMENT_ID)
    expect(mockItemsDeleteIn).toHaveBeenCalledWith("expense_id", ["expense-1", "expense-2"])
    expect(mockDocsDeleteIn).toHaveBeenCalledWith("expense_id", ["expense-1", "expense-2"])
  })

  it("throws if looking up the mirror fails, without attempting any delete", async () => {
    mockSelectEq.mockResolvedValue({ data: null, error: { message: "connection reset" } })
    await expect(deleteClientExpenseMirror(PAYMENT_ID)).rejects.toThrow(/Looking up.*connection reset/)
    expect(mockItemsDeleteIn).not.toHaveBeenCalled()
  })

  it("throws — and does not continue — if deleting the line items fails", async () => {
    mockSelectEq.mockResolvedValue({ data: [{ id: "expense-1" }], error: null })
    mockItemsDeleteIn.mockResolvedValue({ error: { message: "fk violation" } })
    await expect(deleteClientExpenseMirror(PAYMENT_ID)).rejects.toThrow(/line items.*fk violation/)
    expect(mockDocsDeleteIn).not.toHaveBeenCalled()
    expect(mockExpensesDeleteEq).not.toHaveBeenCalled()
  })

  it("throws — and does not continue — if deleting the attached documents fails", async () => {
    mockSelectEq.mockResolvedValue({ data: [{ id: "expense-1" }], error: null })
    mockDocsDeleteIn.mockResolvedValue({ error: { message: "fk violation" } })
    await expect(deleteClientExpenseMirror(PAYMENT_ID)).rejects.toThrow(/attached documents.*fk violation/)
    expect(mockExpensesDeleteEq).not.toHaveBeenCalled()
  })

  it("throws if the final mirror delete itself fails", async () => {
    mockSelectEq.mockResolvedValue({ data: [{ id: "expense-1" }], error: null })
    mockExpensesDeleteEq.mockResolvedValue({ error: { message: "still referenced" } })
    await expect(deleteClientExpenseMirror(PAYMENT_ID)).rejects.toThrow(/client-portal mirror failed.*still referenced/)
  })
})
