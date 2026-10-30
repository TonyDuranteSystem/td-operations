/**
 * The reader behind the "already-paid invoices of exactly this amount" box. The things that must never silently break:
 *  - only invoices genuinely PAID (money received) of EXACTLY this amount and currency, in the window — never a credit
 *    note (negative, but "Paid" too), a refunded one, a test one, an unpaid one, or another currency;
 *  - an invoice another bank payment is already tied to is LEFT OUT and COUNTED, never offered;
 *  - the closest paid day comes first, and the list is capped while the count of what fit is kept;
 *  - an unreadable claim check is an error, never a guess; TD's private money is invisible to staff;
 *  - a payment with nothing to look for (no date, other currency) says it searched nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Call = { method: string; args: unknown[] }
type Reply = { data: unknown; error?: { message: string } | null }
let handler: (table: string, calls: Call[]) => Reply
const log: Array<{ table: string; calls: Call[] }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const calls: Call[] = []
      const settle = () => {
        log.push({ table, calls: [...calls] })
        const r = handler(table, calls)
        return { data: r.data ?? null, error: r.error ?? null }
      }
      const q: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej)
          if (prop === "maybeSingle" || prop === "single") return () => { calls.push({ method: String(prop), args: [] }); return Promise.resolve(settle()) }
          return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return q }
        },
      })
      return q
    },
  },
}))

import { isSameAmountCandidate, loadSameAmountPaid, partitionSameAmount } from "@/lib/finance/same-amount-paid"
import type { RawInvoice } from "@/lib/finance/payer-invoices"

const FEED = { id: "feed1", amount: 3000, currency: "EUR", transaction_date: "2026-02-13", status: "unmatched", owner_account_number: null }

const inv = (id: string, over: Record<string, unknown> = {}): RawInvoice => ({
  id, invoice_number: `INV-${id}`, description: `desc ${id}`, installment: null, total: 3000, amount: 3000,
  amount_due: null, amount_paid: 3000, amount_currency: "EUR", invoice_status: null, status: "Paid",
  paid_date: "2026-02-13", account_id: null, contact_id: "person1", is_test: false,
  accounts: null, contacts: { full_name: "Test Person" }, ...over,
} as unknown as RawInvoice)

describe("isSameAmountCandidate", () => {
  it("accepts a paid invoice of exactly this amount (status Paid, no invoice_status — the shape of a hand-marked one)", () => {
    expect(isSameAmountCandidate(inv("a"), 3000)).toBe(true)
  })
  it("accepts it when only `amount` (not `total`) carries the amount", () => {
    expect(isSameAmountCandidate(inv("a", { total: null }), 3000)).toBe(true)
  })
  it("rejects an invoice that is not paid", () => {
    expect(isSameAmountCandidate(inv("a", { status: "Pending", invoice_status: "Sent" }), 3000)).toBe(false)
    expect(isSameAmountCandidate(inv("a", { status: "Cancelled", invoice_status: null }), 3000)).toBe(false)
  })
  it("rejects a credit note: it reads Paid but it is a negative amount, money paid OUT", () => {
    expect(isSameAmountCandidate(inv("a", { total: -3000, amount: -3000, invoice_status: null }), 3000)).toBe(false)
    expect(isSameAmountCandidate(inv("a", { total: 3000, amount: 3000, invoice_status: "Credit" }), 3000)).toBe(false)
  })
  it("rejects a refunded invoice even when the invoice document still reads Paid (the money went back to the client)", () => {
    expect(isSameAmountCandidate(inv("a", { invoice_status: "Paid", status: "Refunded" }), 3000)).toBe(false)
  })
  it("rejects a test and a different-amount invoice", () => {
    expect(isSameAmountCandidate(inv("a", { is_test: true }), 3000)).toBe(false)
    expect(isSameAmountCandidate(inv("a", { total: 2999.5, amount: 2999.5 }), 3000)).toBe(false)
  })
  it("compares money to the cent, not as text", () => {
    expect(isSameAmountCandidate(inv("a", { total: "80.82", amount: "80.82" }), 80.82)).toBe(true)
    expect(isSameAmountCandidate(inv("a", { total: "80.83", amount: "80.83" }), 80.82)).toBe(false)
  })
})

describe("partitionSameAmount", () => {
  it("leaves out what another bank payment has, and counts it", () => {
    const out = partitionSameAmount([inv("a"), inv("b"), inv("c")], 3000, new Set(["b"]), "2026-02-13", 8)
    expect(out.invoices.map((i) => i.id).sort()).toEqual(["a", "c"])
    expect(out.found).toBe(2)
    expect(out.tied).toBe(1)
    expect(out.invoices.every((i) => i.claimed_by_other === false)).toBe(true)
  })

  it("puts the closest paid day first, then the newest paid", () => {
    const out = partitionSameAmount(
      [inv("far", { paid_date: "2026-02-16" }), inv("same", { paid_date: "2026-02-13" }), inv("before", { paid_date: "2026-02-12" }), inv("after", { paid_date: "2026-02-14" })],
      3000, new Set(), "2026-02-13", 8,
    )
    expect(out.invoices.map((i) => i.id)).toEqual(["same", "after", "before", "far"])
    expect(out.invoices.map((i) => i.days_from_payment)).toEqual([0, 1, -1, 3])
  })

  it("caps what is shown but keeps the full count", () => {
    const rows = Array.from({ length: 12 }, (_, i) => inv(`r${i}`, { paid_date: `2026-02-${String(10 + (i % 6)).padStart(2, "0")}` }))
    const out = partitionSameAmount(rows, 3000, new Set(), "2026-02-13", 8)
    expect(out.invoices).toHaveLength(8)
    expect(out.found).toBe(12)
  })

  it("ignores everything that is not a candidate, and says nothing was left out for it", () => {
    const out = partitionSameAmount([inv("open", { status: "Pending", invoice_status: "Sent" }), inv("credit", { total: -3000, amount: -3000, invoice_status: null })], 3000, new Set(), "2026-02-13", 8)
    expect(out).toEqual({ invoices: [], found: 0, tied: 0 })
  })

  it("keeps an invoice whose paid day is unknown, last", () => {
    const out = partitionSameAmount([inv("nodate", { paid_date: null }), inv("near", { paid_date: "2026-02-14" })], 3000, new Set(), "2026-02-13", 8)
    expect(out.invoices.map((i) => i.id)).toEqual(["near", "nodate"])
    expect(out.invoices[1].days_from_payment).toBeNull()
  })
})

// ── the database half, against a fake ──────────────────────────────────────────────────

let feedRow: Record<string, unknown> | null
let paymentRows: unknown[]
let pointedClaims: unknown[]
let multiClaims: unknown[]
let appClaims: unknown[]
let failTable: string | null

beforeEach(() => {
  log.length = 0
  feedRow = { ...FEED }
  paymentRows = [inv("a")]
  pointedClaims = []
  multiClaims = []
  appClaims = []
  failTable = null
  handler = (table, calls) => {
    if (failTable === table) return { data: null, error: { message: "boom" } }
    if (table === "td_bank_feeds") {
      if (calls.some((c) => c.method === "maybeSingle")) return { data: feedRow }
      if (calls.some((c) => c.method === "in" && c.args[0] === "matched_payment_id")) return { data: pointedClaims }
      return { data: multiClaims }
    }
    if (table === "payments") return { data: paymentRows }
    if (table === "payment_applications") return { data: appClaims }
    return { data: [] }
  }
})

const run = (over: Partial<Parameters<typeof loadSameAmountPaid>[0]> = {}) => loadSameAmountPaid({ feedId: "feed1", isOwner: false, ...over })
const paymentsQuery = () => log.find((e) => e.table === "payments")!.calls
const has = (calls: Call[], method: string, ...args: unknown[]) => calls.some((c) => c.method === method && JSON.stringify(c.args) === JSON.stringify(args))

describe("loadSameAmountPaid — what it asks the database", () => {
  it("looks for this amount, in this currency, paid within 3 days, never a test invoice", async () => {
    await run()
    const q = paymentsQuery()
    expect(has(q, "eq", "amount_currency", "EUR")).toBe(true)
    expect(has(q, "or", "total.eq.3000,amount.eq.3000")).toBe(true)
    expect(has(q, "gte", "paid_date", "2026-02-10")).toBe(true)
    expect(has(q, "lte", "paid_date", "2026-02-16")).toBe(true)
    expect(has(q, "not", "is_test", "is", true)).toBe(true)
  })

  it("the wider look is 30 days either side, and anything else asked for is the everyday 3", async () => {
    await run({ days: 30 })
    expect(has(paymentsQuery(), "gte", "paid_date", "2026-01-14")).toBe(true)
    expect(has(paymentsQuery(), "lte", "paid_date", "2026-03-15")).toBe(true)
    log.length = 0
    await run({ days: 9999 })
    expect(has(paymentsQuery(), "gte", "paid_date", "2026-02-10")).toBe(true)
  })

  it("asks only about the paid invoices it found, never the whole table", async () => {
    paymentsRowsOf(["a", "b"])
    await run()
    const claims = log.filter((e) => e.table === "td_bank_feeds" && e.calls.some((c) => c.method === "in"))
    expect(claims.length).toBeGreaterThan(0)
    expect(has(claims[0].calls, "in", "matched_payment_id", ["a", "b"])).toBe(true)
    expect(has(claims[0].calls, "neq", "id", "feed1")).toBe(true)
  })
})

function paymentsRowsOf(ids: string[]) {
  paymentRows = ids.map((id) => inv(id))
}

describe("loadSameAmountPaid — the answer", () => {
  it("lists a paid invoice and says how far its paid day is", async () => {
    const r = await run()
    expect(r).toMatchObject({ ok: true, searched: true, days: 3, found: 1, already_tied: 0 })
    expect(r.invoices?.[0]).toMatchObject({ id: "a", paid: true, days_from_payment: 0, party: "Test Person", claimed_by_other: false })
  })

  it("leaves out an invoice another bank payment points at, and counts it", async () => {
    paymentsRowsOf(["a", "b"])
    pointedClaims = [{ matched_payment_id: "b" }]
    const r = await run()
    expect(r.invoices?.map((i) => i.id)).toEqual(["a"])
    expect(r).toMatchObject({ found: 1, already_tied: 1 })
  })

  it("also leaves out one a multi-invoice link or a confirmed money application holds", async () => {
    paymentsRowsOf(["a", "b", "c"])
    multiClaims = [{ review_metadata: { multi_audit_link: true, linked_payment_ids: ["b"] } }]
    appClaims = [{ payment_id: "c" }]
    const r = await run()
    expect(r.invoices?.map((i) => i.id)).toEqual(["a"])
    expect(r.already_tied).toBe(2)
  })

  it("a claim check that cannot be read is an ERROR, never a guess", async () => {
    failTable = "payment_applications"
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain("already linked to another payment")
  })

  it("a failed read of the invoices is an error in plain words", async () => {
    failTable = "payments"
    const r = await run()
    expect(r).toMatchObject({ ok: false, error: "Could not read the paid invoices." })
  })

  it("does not list a credit note, an open invoice or a different amount that the database let through", async () => {
    paymentRows = [inv("credit", { total: -3000, amount: -3000, invoice_status: null }), inv("open", { status: "Pending", invoice_status: "Sent" }), inv("other", { total: 3100, amount: 3100 }), inv("ok")]
    const r = await run()
    expect(r.invoices?.map((i) => i.id)).toEqual(["ok"])
  })
})

describe("loadSameAmountPaid — who may see it, and when there is nothing to look for", () => {
  it("404 for a payment that does not exist", async () => {
    feedRow = null
    expect(await run()).toEqual({ ok: false, error: "Transaction not found." })
  })

  it.each([
    ["an outgoing payment", { status: "outgoing" }],
    ["a payment filed to the owner's ledger", { status: "owner_ledger" }],
    ["a payment into one of the owner's own accounts", { owner_account_number: "1234" }],
  ])("%s is invisible to staff, and nothing is read for it", async (_label, over) => {
    feedRow = { ...FEED, ...over }
    expect(await run({ isOwner: false })).toEqual({ ok: false, error: "Transaction not found." })
    expect(log.some((e) => e.table === "payments")).toBe(false)
    // the owner may look
    expect((await run({ isOwner: true })).ok).toBe(true)
  })

  it.each([
    ["no date", { transaction_date: null }],
    ["an unusable date", { transaction_date: "soon" }],
    ["a currency invoices do not exist in", { currency: "GBP" }],
    ["no amount", { amount: null }],
    ["a zero amount", { amount: 0 }],
  ])("%s: it says it searched nothing, and reads no invoice", async (_label, over) => {
    feedRow = { ...FEED, ...over }
    const r = await run()
    expect(r).toMatchObject({ ok: true, searched: false, invoices: [], found: 0, already_tied: 0 })
    expect(log.some((e) => e.table === "payments")).toBe(false)
  })
})
