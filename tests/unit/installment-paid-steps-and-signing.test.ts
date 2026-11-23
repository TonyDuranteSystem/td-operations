/**
 * Two follow-ups of dev job bea928e0 (bug-hunter pass on the invoice-type build):
 *  1. runInstallmentPaidSteps — an installment born Paid runs the same yearly steps as one marked paid, for a Client company only.
 *  2. The contract signing does not treat a CANCELLED January installment as "already invoiced" — the client signs and is invoiced.
 *
 * Break the Client-only rule and the first block fails; send January's number to June's handler and the number cases fail; make the
 * signing skip on a dead row again and the last block fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { accountType, onFirst, onSecond, rows, mockCreateTDInvoice } = vi.hoisted(() => ({
  accountType: { value: "Client" as string | null },
  onFirst: vi.fn(),
  onSecond: vi.fn(),
  rows: { keyed: null as Record<string, unknown> | null },
  mockCreateTDInvoice: vi.fn(),
}))

vi.mock("@/lib/installment-handler", () => ({ onFirstInstallmentPaid: onFirst, onSecondInstallmentPaid: onSecond }))
vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: mockCreateTDInvoice }))
vi.mock("@/lib/invoice-auto-send", () => ({ autoSendInvoices: vi.fn(async () => [{ success: true }]) }))
vi.mock("@/lib/supabase-admin", () => {
  const AGREEMENT = { id: "ag-1", token: "tok", account_id: "acct-1", status: "signed", client_name: "Test Client", agreement_year: 2026 }
  const ACCOUNT = { id: "acct-1", company_name: "Test LLC", installment_1_amount: 1000, entity_type: "Single Member LLC", portal_tier: "active" }
  const chain = (table: string) => {
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            if (table === "contracts") return resolve({ count: 1, data: null, error: null })
            return resolve({ data: null, error: null })
          }
        }
        if (prop === "single" || prop === "maybeSingle") {
          return async () => {
            if (table === "annual_agreements") return { data: AGREEMENT, error: null }
            if (table === "accounts") return { data: { ...ACCOUNT, account_type: accountType.value }, error: null }
            if (table === "payments") return { data: rows.keyed, error: null }
            return { data: null, error: null }
          }
        }
        return () => proxy
      },
    })
    return proxy
  }
  return { supabaseAdmin: { from: (table: string) => chain(table) } }
})

import { runInstallmentPaidSteps } from "@/lib/billing/run-installment-paid-steps"
import { processAgreementSigned } from "@/lib/offers/process-agreement-signed"

beforeEach(() => {
  accountType.value = "Client"
  rows.keyed = null
  onFirst.mockReset()
  onSecond.mockReset()
  mockCreateTDInvoice.mockReset()
  onFirst.mockResolvedValue({ steps: [{ step: "recurring_services", status: "created" }] })
  onSecond.mockResolvedValue({ steps: [{ step: "tax_gate", status: "created" }] })
  mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-new", expenseId: "e", invoiceNumber: "INV-000100", total: 1000, status: "Draft" })
})

describe("runInstallmentPaidSteps", () => {
  it("January runs the first-installment steps, June the second — with the installment's own year", async () => {
    const jan = await runInstallmentPaidSteps({ accountId: "acct-1", installment: "Installment 1 (Jan)", year: 2026 })
    expect(onFirst).toHaveBeenCalledWith("acct-1", 2026)
    expect(onSecond).not.toHaveBeenCalled()
    expect(jan).toEqual({ ran: true, failedSteps: [] })
    onFirst.mockClear()
    await runInstallmentPaidSteps({ accountId: "acct-1", installment: "Installment 2 (Jun)", year: 2025 })
    expect(onSecond).toHaveBeenCalledWith("acct-1", 2025)
    expect(onFirst).not.toHaveBeenCalled()
  })

  it("only a Client company runs them — anything else is skipped and says why", async () => {
    for (const type of ["Partner", "Lead", null]) {
      accountType.value = type
      const r = await runInstallmentPaidSteps({ accountId: "acct-1", installment: "Installment 1 (Jan)", year: 2026 })
      expect(r.ran).toBe(false)
      expect(r.reason).toMatch(/not Client/)
    }
    expect(onFirst).not.toHaveBeenCalled()
    expect(onSecond).not.toHaveBeenCalled()
  })

  it("a label that is not an installment runs nothing", async () => {
    const r = await runInstallmentPaidSteps({ accountId: "acct-1", installment: "Setup Fee", year: 2026 })
    expect(r.ran).toBe(false)
    expect(onFirst).not.toHaveBeenCalled()
    expect(onSecond).not.toHaveBeenCalled()
  })

  it("lists the steps that reported an error", async () => {
    onFirst.mockResolvedValue({ steps: [{ step: "recurring_services", status: "error" }, { step: "cmra", status: "created" }] })
    const r = await runInstallmentPaidSteps({ accountId: "acct-1", installment: "Installment 1 (Jan)", year: 2026 })
    expect(r).toEqual({ ran: true, failedSteps: ["recurring_services"] })
  })
})

describe("contract signing and a cancelled January installment", () => {
  it("a CANCELLED invoice holding the key does not stop the client being invoiced", async () => {
    rows.keyed = { id: "pay-dead", invoice_number: "INV-000001", status: "Cancelled", invoice_status: "Cancelled" }
    const out = await processAgreementSigned("tok")
    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    expect(mockCreateTDInvoice.mock.calls[0][0]).toMatchObject({ idempotency_key: "renewal-1st:acct-1:2026", installment: "Installment 1 (Jan)", year: 2026 })
    expect((out.body as { idempotent?: boolean }).idempotent).toBeUndefined()
    expect((out.body as { invoice_number?: string }).invoice_number).toBe("INV-000100")
  })

  it("a LIVE invoice holding the key still skips (no second January invoice)", async () => {
    rows.keyed = { id: "pay-live", invoice_number: "INV-000555", status: "Pending", invoice_status: "Sent" }
    const out = await processAgreementSigned("tok")
    expect(mockCreateTDInvoice).not.toHaveBeenCalled()
    expect(out.body).toMatchObject({ idempotent: true, invoice_number: "INV-000555" })
  })

  it("no invoice at all → it creates one", async () => {
    rows.keyed = null
    await processAgreementSigned("tok")
    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
  })
})
