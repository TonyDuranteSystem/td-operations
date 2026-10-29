/**
 * One bank transaction linked, for the record, to SEVERAL already-Paid invoices.
 *
 * The real case: a $125 Stripe payment paid a $50 invoice and a $75 invoice, both already marked
 * Paid; the payment could be linked to only one of them. Delete the "all must be Paid" check and
 * the open-invoice refusal fails; delete the first-invoice pointer and the pointer test fails;
 * delete `multi_audit_link` from the metadata and the claim-guard reader test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

interface FeedRow { id: string; amount: number; currency: string | null; status: string }
interface PayRow {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
  total: number | null
  amount: number | null
  amount_currency: string | null
  notes: string | null
}

let feedRow: FeedRow | null = null
let payRows: PayRow[] = []
const feedWrites: Array<{ id: string; patch: Record<string, unknown>; context: string }> = []
const invoiceNoteWrites: Array<{ id: string; notes: string }> = []
const mirrorWrites: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "td_bank_feeds") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: feedRow, error: null }) }) }) }
      }
      if (table === "payments") {
        return { select: () => ({ in: (_c: string, ids: string[]) => Promise.resolve({ data: payRows.filter((p) => ids.includes(p.id)), error: null }) }) }
      }
      if (table === "td_books_transactions") {
        return { update: (patch: Record<string, unknown>) => ({ eq: () => { mirrorWrites.push(patch); return Promise.resolve({ error: null }) } }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))
vi.mock("@/lib/finance/feed-write", () => ({
  updateFeed: async (id: string, patch: Record<string, unknown>, context: string) => {
    feedWrites.push({ id, patch, context })
    return { ok: true }
  },
}))
vi.mock("@/app/(dashboard)/finance/actions", () => ({
  updateInvoice: async (id: string, patch: { notes: string }) => {
    invoiceNoteWrites.push({ id, notes: patch.notes })
    return { success: true }
  },
}))
vi.mock("@/lib/finance/apply-payment", () => ({ applyMoneyToInvoice: vi.fn() }))
vi.mock("@/lib/stripe-sync", () => ({ isChargeRefundedNow: vi.fn() }))
vi.mock("@/lib/operations/payment", () => ({}))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => {} }))

import { linkFeedTransactionToInvoices } from "@/lib/finance/owner-transaction-link"
import {
  readLinkedPaymentIds,
  summarizeMultiLink,
  multiLinkMetadata,
  CLEAR_MULTI_LINK_METADATA,
  otherMultiLinkedInvoices,
} from "@/lib/finance/multi-invoice-link"

const inv = (id: string, number: string, total: number, over: Partial<PayRow> = {}): PayRow => ({
  id, invoice_number: number, invoice_status: "Paid", status: "Paid", total, amount: total,
  amount_currency: "USD", notes: null, ...over,
})

beforeEach(() => {
  feedRow = { id: "feed1", amount: 125, currency: "USD", status: "unmatched" }
  payRows = [inv("p50", "INV-002323", 50), inv("p75", "INV-002121", 75)]
  feedWrites.length = 0
  invoiceNoteWrites.length = 0
  mirrorWrites.length = 0
})

const run = (ids: string[]) =>
  linkFeedTransactionToInvoices({ feedId: "feed1", paymentIds: ids, note: "Public notary", actor: "dashboard:antonio" })

describe("linkFeedTransactionToInvoices — the $125 = $50 + $75 case", () => {
  it("links one payment to both paid invoices and reports they add up", async () => {
    const r = await run(["p50", "p75"])
    expect(r.ok).toBe(true)
    expect(r.invoiceNumbers).toEqual(["INV-002323", "INV-002121"])
    expect(r.linkedTotal).toBe(125)
    expect(r.difference).toBe(0)
  })

  it("points the transaction at the FIRST invoice and records the whole set", async () => {
    await run(["p50", "p75"])
    expect(feedWrites).toHaveLength(1)
    const patch = feedWrites[0].patch
    expect(patch.matched_payment_id).toBe("p50")
    expect(patch.status).toBe("matched")
    expect(patch.match_confidence).toBe("manual")
    const meta = patch.review_metadata as Record<string, unknown>
    expect(meta.multi_audit_link).toBe(true)
    expect(meta.audit_link).toBe(true)
    expect(meta.money_applied).toBe(false)
    expect(meta.linked_payment_ids).toEqual(["p50", "p75"])
    expect(readLinkedPaymentIds(meta)).toEqual(["p50", "p75"])
  })

  it("writes the dated note onto EVERY invoice without overwriting an earlier one", async () => {
    payRows[1] = inv("p75", "INV-002121", 75, { notes: "earlier note" })
    await run(["p50", "p75"])
    expect(invoiceNoteWrites.map((w) => w.id)).toEqual(["p50", "p75"])
    expect(invoiceNoteWrites[0].notes).toMatch(/: Public notary$/)
    expect(invoiceNoteWrites[1].notes.startsWith("earlier note\n")).toBe(true)
  })

  it("mirrors the link onto the My Finances row, pointing at the first invoice", async () => {
    await run(["p50", "p75"])
    expect(mirrorWrites).toHaveLength(1)
    expect(mirrorWrites[0].linked_payment_id).toBe("p50")
  })

  it("reports a difference without blocking when the invoices do not add up", async () => {
    payRows[1] = inv("p75", "INV-002121", 50)
    const r = await run(["p50", "p75"])
    expect(r.ok).toBe(true)
    expect(r.linkedTotal).toBe(100)
    expect(r.difference).toBe(25)
  })
})

describe("linkFeedTransactionToInvoices — refusals (nothing is written)", () => {
  const nothingWritten = () => {
    expect(feedWrites).toHaveLength(0)
    expect(invoiceNoteWrites).toHaveLength(0)
    expect(mirrorWrites).toHaveLength(0)
  }

  it("needs at least two different invoices", async () => {
    expect((await run(["p50"])).ok).toBe(false)
    expect((await run(["p50", "p50"])).ok).toBe(false)
    expect((await run([])).ok).toBe(false)
    nothingWritten()
  })

  it("refuses a transaction that already settled an invoice", async () => {
    feedRow = { id: "feed1", amount: 125, currency: "USD", status: "matched" }
    const r = await run(["p50", "p75"])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already settled/)
    nothingWritten()
  })

  it("refuses when any invoice is still open, naming it and pointing at Match to invoice", async () => {
    payRows[1] = inv("p75", "INV-002121", 75, { invoice_status: "Sent", status: "Pending" })
    const r = await run(["p50", "p75"])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/INV-002121 is still open/)
    expect(r.error).toMatch(/Match to invoice/)
    nothingWritten()
  })

  it("refuses a voided or cancelled invoice", async () => {
    payRows[1] = inv("p75", "INV-002121", 75, { invoice_status: "Voided", status: "Pending" })
    expect((await run(["p50", "p75"])).ok).toBe(false)
    nothingWritten()
  })

  it("refuses an invoice in a different currency than the payment", async () => {
    payRows[1] = inv("p75", "INV-002121", 75, { amount_currency: "EUR" })
    const r = await run(["p50", "p75"])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/EUR/)
    nothingWritten()
  })

  it("refuses when one of the invoices does not exist", async () => {
    const r = await run(["p50", "missing"])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not be found/)
    nothingWritten()
  })

  it("refuses an unreasonable number of invoices", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `x${i}`)
    expect((await run(ids)).ok).toBe(false)
    nothingWritten()
  })
})

describe("multi-link metadata helpers", () => {
  it("only trusts the set when the multi-link flag is on (stale keys never claim invoices)", () => {
    const real = multiLinkMetadata({
      note: "n", transactionAmount: 125,
      invoices: [{ id: "a", invoice_number: "A", total: 50 }, { id: "b", invoice_number: "B", total: 75 }],
    })
    expect(readLinkedPaymentIds(real)).toEqual(["a", "b"])
    // a later single link / un-match overwrites the keys with null (review_metadata merges)
    const cleared = { ...real, ...CLEAR_MULTI_LINK_METADATA }
    expect(readLinkedPaymentIds(cleared)).toEqual([])
    expect(readLinkedPaymentIds({ linked_payment_ids: ["a"] })).toEqual([])
    expect(readLinkedPaymentIds(null)).toEqual([])
    expect(readLinkedPaymentIds("x")).toEqual([])
    expect(readLinkedPaymentIds({ multi_audit_link: true, linked_payment_ids: "nope" })).toEqual([])
  })

  it("adds amounts to the cent without float dust", () => {
    expect(summarizeMultiLink(0.3, [0.1, 0.2])).toEqual({ linkedTotal: 0.3, difference: 0, matches: true })
    expect(summarizeMultiLink(125, [50, 75])).toEqual({ linkedTotal: 125, difference: 0, matches: true })
    expect(summarizeMultiLink(125, [50])).toEqual({ linkedTotal: 50, difference: 75, matches: false })
    expect(summarizeMultiLink(100, [60, 60]).difference).toBe(-20)
    expect(summarizeMultiLink(100, [null, undefined, 40]).linkedTotal).toBe(40)
  })
})

describe("otherMultiLinkedInvoices — what the matched row names beside the first invoice", () => {
  const meta = multiLinkMetadata({
    note: "n", transactionAmount: 125,
    invoices: [{ id: "a", invoice_number: "INV-A", total: 50 }, { id: "b", invoice_number: "INV-B", total: 75 }],
  })
  it("returns the invoices other than the one the row points at", () => {
    expect(otherMultiLinkedInvoices(meta, "a").map((i) => i.invoice_number)).toEqual(["INV-B"])
  })
  it("returns nothing for an ordinary row, a cleared link, or no metadata", () => {
    expect(otherMultiLinkedInvoices({ audit_link: true }, "a")).toEqual([])
    expect(otherMultiLinkedInvoices({ ...meta, ...CLEAR_MULTI_LINK_METADATA }, "a")).toEqual([])
    expect(otherMultiLinkedInvoices(null, "a")).toEqual([])
  })
})
