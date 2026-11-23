/**
 * A cancelled installment can be invoiced again, and an existing invoice is really recognised (dev job bea928e0).
 *
 * These run the REAL createTDInvoice up to its key lookup (only the database edge is faked), because the earlier tests
 * mocked createTDInvoice itself and so could not notice if the "already existed" flag or the dead-row handling disappeared.
 *
 * Break "free the key of a cancelled installment" and the retire cases fail; free a credit note's or a live invoice's key and the
 * "never touched" cases fail; drop `alreadyExisted: true` from the lookup and the first case fails; stop excluding dead rows in the
 * lookup and the filter case fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Op = [string, unknown[]]
interface Rec { table: string; ops: Op[] }

const { recs, payState } = vi.hoisted(() => ({
  recs: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
  payState: { liveRow: null as Record<string, unknown> | null, retiredRows: [] as Array<{ id: string }> },
}))

vi.mock("@/lib/supabase-admin", () => {
  const chain = (table: string) => {
    const rec: Rec = { table, ops: [] }
    recs.push(rec)
    const result = () => {
      if (rec.ops.some(([name]) => name === "update")) return { data: payState.retiredRows, error: null }
      if (table === "payments") return { data: payState.liveRow, error: null }
      if (table === "client_expenses") return { data: { id: "exp-1" }, error: null }
      return { data: null, error: null }
    }
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result())
        return (...args: unknown[]) => { rec.ops.push([String(prop), args]); return proxy }
      },
    })
    return proxy
  }
  return { supabaseAdmin: { from: (table: string) => chain(table) } }
})
vi.mock("@/lib/db", () => ({ dbWrite: vi.fn(), dbWriteSafe: vi.fn() }))
vi.mock("@/lib/portal/td-invoice-mirror", () => ({ syncTDInvoiceMirror: vi.fn() }))
vi.mock("@/lib/portal/invoice-number", () => ({ generateInvoiceNumber: vi.fn(), generateCreditNoteNumber: vi.fn(), isUniqueViolation: vi.fn(() => false) }))
vi.mock("@/lib/operations/credit-netting", () => ({
  computeCreditApplication: vi.fn(), consumeCredits: vi.fn(), releaseStaleCreditClaims: vi.fn(),
  claimCredits: vi.fn(), confirmCreditClaims: vi.fn(), unwindCreditClaims: vi.fn(),
}))
vi.mock("@/lib/payments/card-fee-config", () => ({ resolveCreationCardFeeRate: vi.fn(async () => 0) }))
vi.mock("@/lib/portal/office-hours", () => ({ getOfficeDateString: vi.fn(() => "2026-11-22") }))
vi.mock("@/lib/invoices/departments", () => ({ departmentFields: vi.fn(() => ({})) }))

import { createTDInvoice } from "@/lib/portal/td-invoice"
import { retireDeadInstallmentKey } from "@/lib/billing/retire-dead-installment-key"
import { isInstallmentIdempotencyKey, isDeadInstallmentRow } from "@/lib/billing/installment-invoice-key"

const ACCT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const JAN_KEY = `renewal-1st:${ACCT}:2026`
const JUNE_KEY = `annual-installment:${ACCT}:2:2026`
const baseInput = { account_id: ACCT, line_items: [{ description: "Shipping Service", unit_price: 100 }] }

beforeEach(() => {
  recs.length = 0
  payState.liveRow = null
  payState.retiredRows = []
})

const updates = () => recs.filter((r) => r.ops.some(([n]) => n === "update"))
const inserts = () => recs.filter((r) => r.ops.some(([n]) => n === "insert"))

describe("which keys and rows count", () => {
  it("recognises only the two installment keys", () => {
    expect(isInstallmentIdempotencyKey(JAN_KEY)).toBe(true)
    expect(isInstallmentIdempotencyKey(JUNE_KEY)).toBe(true)
    for (const other of [
      `manual-crm-invoice:${ACCT}:abc`, "offer-tranche:tok:2", `offer-signed:tok:${ACCT}`, `annual-installment:${ACCT}:1:2026`,
      `renewal-1st:${ACCT}`, `credit-note:${ACCT}:123`, "", null, undefined,
    ]) {
      expect(isInstallmentIdempotencyKey(other as string | null | undefined)).toBe(false)
    }
  })

  it("a cancelled or voided invoice is dead; a live one and a credit note are not", () => {
    expect(isDeadInstallmentRow({ status: "Cancelled", invoice_status: "Sent" })).toBe(true)
    expect(isDeadInstallmentRow({ status: "Pending", invoice_status: "Cancelled" })).toBe(true)
    expect(isDeadInstallmentRow({ status: "Waived", invoice_status: "Voided" })).toBe(true)
    expect(isDeadInstallmentRow({ status: "Pending", invoice_status: "Sent" })).toBe(false)
    expect(isDeadInstallmentRow({ status: "Paid", invoice_status: "Paid" })).toBe(false)
    expect(isDeadInstallmentRow({ status: "Paid", invoice_status: "Credit" })).toBe(false)
    expect(isDeadInstallmentRow({ status: null, invoice_status: null })).toBe(false)
  })
})

describe("retireDeadInstallmentKey frees only a dead installment's key", () => {
  it("clears the key on cancelled / voided rows only — never on a credit note or a live invoice", async () => {
    payState.retiredRows = [{ id: "old-1" }]
    const n = await retireDeadInstallmentKey(JAN_KEY)
    expect(n).toBe(1)
    const rec = updates()[0]
    expect(rec.table).toBe("payments")
    const byName = (name: string) => rec.ops.find(([op]) => op === name)?.[1]
    expect(byName("update")).toEqual([{ idempotency_key: null }])
    expect(byName("eq")).toEqual(["idempotency_key", JAN_KEY])
    const orFilter = String((byName("or") as string[])[0])
    expect(orFilter).toContain("status.eq.Cancelled")
    expect(orFilter).toContain("invoice_status.eq.Cancelled")
    expect(orFilter).toContain("invoice_status.eq.Voided")
    expect(orFilter).not.toContain("Credit")
    expect(orFilter).not.toContain("Paid")
  })

  it("does nothing at all for a key that is not an installment key", async () => {
    for (const key of [`manual-crm-invoice:${ACCT}:abc`, "offer-tranche:tok:1", `offer-signed:tok:${ACCT}`, null, undefined]) {
      expect(await retireDeadInstallmentKey(key)).toBe(0)
    }
    expect(recs).toHaveLength(0)
  })
})

describe("createTDInvoice — the key lookup the 'already existed' feature rests on", () => {
  it("returns the existing invoice, flagged alreadyExisted, and writes nothing", async () => {
    payState.liveRow = { id: "pay-live", invoice_number: "INV-000777", total: "1000", invoice_status: "Draft", status: "Pending" }
    const res = await createTDInvoice({ ...baseInput, idempotency_key: `manual-crm-invoice:${ACCT}:abc` })
    expect(res.alreadyExisted).toBe(true)
    expect(res.invoiceNumber).toBe("INV-000777")
    expect(res.paymentId).toBe("pay-live")
    expect(res.total).toBe(1000)
    expect(inserts()).toHaveLength(0)
    expect(updates()).toHaveLength(0)
  })

  it("the lookup skips cancelled, voided and credit rows", async () => {
    payState.liveRow = { id: "pay-live", invoice_number: "INV-000777", total: 1, invoice_status: "Draft", status: "Pending" }
    await createTDInvoice({ ...baseInput, idempotency_key: `manual-crm-invoice:${ACCT}:abc` })
    const lookup = recs.find((r) => r.table === "payments")!
    const get = (name: string) => lookup.ops.filter(([op]) => op === name).map(([, a]) => a)
    expect(get("eq")).toContainEqual(["idempotency_key", `manual-crm-invoice:${ACCT}:abc`])
    expect(get("neq")).toContainEqual(["status", "Cancelled"])
    expect(get("not")).toContainEqual(["invoice_status", "in", "(Cancelled,Voided,Credit)"])
  })

  it("an installment key frees a dead holder BEFORE it looks the key up", async () => {
    payState.liveRow = { id: "pay-live", invoice_number: "INV-000888", total: 1, invoice_status: "Draft", status: "Pending" }
    const res = await createTDInvoice({ ...baseInput, idempotency_key: JUNE_KEY, installment: "Installment 2 (Jun)", year: 2026 })
    expect(res.alreadyExisted).toBe(true)
    const paymentRecs = recs.filter((r) => r.table === "payments")
    expect(paymentRecs[0].ops.some(([op]) => op === "update")).toBe(true) // the retire comes first
    expect(paymentRecs[1].ops.some(([op]) => op === "select")).toBe(true) // then the lookup
  })

  it("a key that is not an installment key never triggers the clearing write", async () => {
    payState.liveRow = { id: "pay-live", invoice_number: "INV-000999", total: 1, invoice_status: "Draft", status: "Pending" }
    for (const key of [`manual-crm-invoice:${ACCT}:abc`, "offer-tranche:tok:2", `credit-note:${ACCT}:1`]) {
      recs.length = 0
      await createTDInvoice({ ...baseInput, idempotency_key: key })
      expect(updates()).toHaveLength(0)
    }
  })
})
