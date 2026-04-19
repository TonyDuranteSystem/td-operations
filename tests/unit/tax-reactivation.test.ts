/**
 * lib/tax/reactivation.ts — unit tests
 *
 * Covers the pure logic of reactivateOnHoldTaxReturns: which SDs get
 * flipped, which get skipped, how the installment detection covers both
 * structured (payments.installment) and legacy (payments.description)
 * values, and how errors are counted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

let serviceDeliveries: Array<Record<string, unknown>> = []
let accounts: Array<Record<string, unknown>> = []
let payments: Array<Record<string, unknown>> = []
let updateCalls: Array<{ id: string; status: string }> = []
let nextUpdateError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const state: { where: Array<[string, unknown]>; notNullCol: string | null; inCol: [string, unknown[]] | null; updatePayload: Record<string, unknown> | null } = {
        where: [],
        notNullCol: null,
        inCol: null,
        updatePayload: null,
      }
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, v: unknown) => {
          state.where.push([col, v])
          return chain
        }),
        in: vi.fn((col: string, arr: unknown[]) => {
          state.inCol = [col, arr]
          return chain
        }),
        not: vi.fn((col: string, _op: string, val: unknown) => {
          if (val === null) state.notNullCol = col
          return chain
        }),
        limit: vi.fn(() => chain),
        order: vi.fn(() => chain),
        update: vi.fn((payload: Record<string, unknown>) => {
          state.updatePayload = payload
          return chain
        }),
        then: (resolve: (v: unknown) => void) => {
          let rows: Array<Record<string, unknown>> = []
          if (state.updatePayload) {
            // Mock of an UPDATE chain. Capture the target id + payload.
            const idFilter = state.where.find(([c]) => c === "id")
            if (idFilter) {
              updateCalls.push({
                id: idFilter[1] as string,
                status: state.updatePayload.status as string,
              })
            }
            resolve({ data: null, error: nextUpdateError })
            return
          }
          if (table === "service_deliveries") rows = serviceDeliveries
          if (table === "accounts") rows = accounts
          if (table === "payments") rows = payments
          // Apply simple in-memory filters for eq / in / not-null.
          let filtered = rows
          for (const [col, val] of state.where) {
            filtered = filtered.filter(r => r[col] === val)
          }
          if (state.inCol) {
            const [col, vals] = state.inCol
            filtered = filtered.filter(r => vals.includes(r[col]))
          }
          if (state.notNullCol) {
            const col = state.notNullCol
            filtered = filtered.filter(r => r[col] !== null && r[col] !== undefined)
          }
          resolve({ data: filtered, error: null })
        },
      })
      return chain
    },
  },
}))

beforeEach(() => {
  serviceDeliveries = []
  accounts = []
  payments = []
  updateCalls = []
  nextUpdateError = null
})

describe("reactivateOnHoldTaxReturns", () => {
  it("flips on_hold Tax Return SDs to active when a 2nd installment is paid", async () => {
    serviceDeliveries = [
      { id: "sd-1", account_id: "acct-1", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-1", company_name: "Alpha LLC" }]
    payments = [
      {
        id: "p-1",
        account_id: "acct-1",
        status: "Paid",
        installment: "Installment 2 (Jun)",
        description: "Second Installment 2026",
        paid_date: "2026-06-15",
      },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.scanned).toBe(1)
    expect(res.reactivated).toBe(1)
    expect(res.skipped).toBe(0)
    expect(res.errors).toBe(0)
    expect(updateCalls).toEqual([{ id: "sd-1", status: "active" }])
    expect(res.details[0].company_name).toBe("Alpha LLC")
  })

  it("matches legacy payments via description ILIKE when installment is null", async () => {
    serviceDeliveries = [
      { id: "sd-2", account_id: "acct-2", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-2", company_name: "Legacy LLC" }]
    payments = [
      {
        id: "p-2",
        account_id: "acct-2",
        status: "Paid",
        installment: null,
        description: "Second Installment – LLC Consulting & Management",
        paid_date: "2026-04-05",
      },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.reactivated).toBe(1)
    expect(updateCalls).toEqual([{ id: "sd-2", status: "active" }])
  })

  it("matches '2nd installment' phrasing in description", async () => {
    serviceDeliveries = [
      { id: "sd-3", account_id: "acct-3", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-3", company_name: "Abbrev LLC" }]
    payments = [
      {
        id: "p-3",
        account_id: "acct-3",
        status: "Paid",
        installment: null,
        description: "Payment for 2nd installment 2026",
        paid_date: "2026-06-10",
      },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.reactivated).toBe(1)
  })

  it("skips SDs whose account has no 2nd installment payment on file", async () => {
    serviceDeliveries = [
      { id: "sd-4", account_id: "acct-4", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-4", company_name: "Unpaid LLC" }]
    payments = [
      {
        id: "p-4",
        account_id: "acct-4",
        status: "Paid",
        installment: "Installment 1 (Jan)", // only 1st installment
        description: "First Installment 2026",
        paid_date: "2026-01-15",
      },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.reactivated).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.details[0].action).toBe("skipped_no_payment")
    expect(updateCalls).toEqual([])
  })

  it("ignores non-Paid payments (Pending / Overdue)", async () => {
    serviceDeliveries = [
      { id: "sd-5", account_id: "acct-5", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-5", company_name: "Pending LLC" }]
    payments = [
      {
        id: "p-5a",
        account_id: "acct-5",
        status: "Overdue",
        installment: "Installment 2 (Jun)",
        description: "2nd Installment",
        paid_date: null,
      },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.reactivated).toBe(0)
    expect(res.skipped).toBe(1)
  })

  it("supports scoped reactivation by accountIdFilter", async () => {
    serviceDeliveries = [
      { id: "sd-6a", account_id: "acct-6a", service_type: "Tax Return", status: "on_hold" },
      { id: "sd-6b", account_id: "acct-6b", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [
      { id: "acct-6a", company_name: "Target LLC" },
      { id: "acct-6b", company_name: "Other LLC" },
    ]
    payments = [
      { id: "p-6a", account_id: "acct-6a", status: "Paid", installment: "Installment 2 (Jun)", description: "", paid_date: "2026-06-15" },
      { id: "p-6b", account_id: "acct-6b", status: "Paid", installment: "Installment 2 (Jun)", description: "", paid_date: "2026-06-15" },
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns("acct-6a")
    expect(res.scanned).toBe(1)
    expect(res.reactivated).toBe(1)
    expect(updateCalls).toEqual([{ id: "sd-6a", status: "active" }])
  })

  it("counts errors when the UPDATE fails", async () => {
    serviceDeliveries = [
      { id: "sd-7", account_id: "acct-7", service_type: "Tax Return", status: "on_hold" },
    ]
    accounts = [{ id: "acct-7", company_name: "Error LLC" }]
    payments = [
      { id: "p-7", account_id: "acct-7", status: "Paid", installment: "Installment 2 (Jun)", description: "", paid_date: "2026-06-15" },
    ]
    nextUpdateError = { message: "database is asleep" }
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.errors).toBe(1)
    expect(res.reactivated).toBe(0)
    expect(res.details[0].action).toBe("error")
    expect(res.details[0].error_message).toBe("database is asleep")
  })

  it("returns zeros when there are no on_hold Tax Return SDs to scan", async () => {
    serviceDeliveries = [
      { id: "sd-8", account_id: "acct-8", service_type: "Tax Return", status: "active" }, // not on_hold
    ]
    const { reactivateOnHoldTaxReturns } = await import("@/lib/tax/reactivation")
    const res = await reactivateOnHoldTaxReturns()
    expect(res.scanned).toBe(0)
    expect(res.reactivated).toBe(0)
    expect(res.details).toEqual([])
  })
})
