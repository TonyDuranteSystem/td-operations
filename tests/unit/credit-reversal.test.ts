/**
 * WS-A refund/dispute handling (dev job c0a61e44) — the adversarial-QA blocker
 * fixes: the void is rowcount-checked, and an IN-FLIGHT credit is never
 * mislabelled as spent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state: {
  credit: Record<string, unknown> | null
  updateRows: unknown[]
  errors: Array<Record<string, unknown>>
} = { credit: null, updateRows: [], errors: [] }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const chain: any = {}
      for (const m of ["select", "eq", "is", "update", "neq"]) chain[m] = () => chain
      chain.maybeSingle = async () => ({ data: state.credit, error: null })
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: state.updateRows, error: null }).then(res)
      return chain
    },
  },
}))

vi.mock("@/lib/system-errors", () => ({
  reportSystemError: async (input: Record<string, unknown>) => {
    state.errors.push(input)
    return { fingerprint: "test" }
  },
}))

import { handleChargeReversal } from "@/lib/operations/credit-reversal"

beforeEach(() => {
  state.credit = null
  state.updateRows = []
  state.errors = []
})

describe("refund on an UNSPENT credit", () => {
  it("voids it when the conditional update actually matched a row", async () => {
    state.credit = { id: "cr", credit_remaining: 257, total: -257, invoice_status: "Credit", credit_consumed_by: null }
    state.updateRows = [{ id: "cr" }]
    const res = await handleChargeReversal("ch_1", "charge.refunded")
    expect(res.outcome).toBe("voided")
  })

  it("BLOCKER FIX: a lost race (0 rows matched) reports needs_review, never a false 'voided'", async () => {
    state.credit = { id: "cr", credit_remaining: 257, total: -257, invoice_status: "Credit", credit_consumed_by: null }
    state.updateRows = [] // a signing claimed it between the read and the write
    const res = await handleChargeReversal("ch_2", "charge.refunded")
    expect(res.outcome).toBe("needs_review")
    expect(state.errors.length).toBe(1)
    expect(String(state.errors[0].message)).toContain("could NOT be voided")
  })
})

describe("refund on an IN-FLIGHT credit (claimed, balance intact)", () => {
  it("MAJOR FIX: is not called spent — the card says in-flight, not 'true-up an invoice'", async () => {
    state.credit = { id: "cr", credit_remaining: 257, total: -257, invoice_status: "Credit", credit_consumed_by: "token-x" }
    const res = await handleChargeReversal("ch_3", "charge.dispute.created")
    expect(res.outcome).toBe("needs_review")
    expect(String(state.errors[0].message)).toContain("WHILE an invoice was being created")
    expect(state.errors[0].context).toMatchObject({ state: "in_flight" })
  })
})

describe("refund on a SPENT credit", () => {
  it("raises the true-up card and never touches the invoice", async () => {
    state.credit = { id: "cr", credit_remaining: 0, total: -257, invoice_status: "Credit", credit_consumed_by: "inv-1" }
    const res = await handleChargeReversal("ch_4", "charge.refunded")
    expect(res.outcome).toBe("needs_review")
    expect(String(state.errors[0].message)).toContain("TRUE-UP")
  })
})

describe("a refund for a charge that is not one of ours", () => {
  it("is a clean no-op — existing refund behavior is unchanged", async () => {
    state.credit = null
    const res = await handleChargeReversal("ch_other", "charge.refunded")
    expect(res.outcome).toBe("no_credit_found")
    expect(state.errors.length).toBe(0)
  })
})

describe("duplicate refund events", () => {
  it("a second delivery after a successful void finds nothing to void and says so", async () => {
    state.credit = { id: "cr", credit_remaining: 0, total: -257, invoice_status: "Cancelled", credit_consumed_by: null }
    const res = await handleChargeReversal("ch_5", "charge.refunded")
    // remaining 0 → treated as spent → review rather than a second void
    expect(res.outcome).toBe("needs_review")
  })
})
