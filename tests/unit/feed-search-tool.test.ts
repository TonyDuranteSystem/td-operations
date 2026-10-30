/**
 * `search_bank_feeds`, the investigator's window onto the Bank Feed. What must hold: TD's private money is
 * never asked for, a filter is always present, and a word cannot change the filter it is sent in.
 * Delete the private-row filters and the privacy test fails; drop the word sanitiser and the injection test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Call = { method: string; args: unknown[] }
let calls: Call[] = []
let reply: { data: unknown; error: { message: string } | null } = { data: [], error: null }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(reply).then(res, rej)
          return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return q }
        },
      })
      return q
    },
  },
}))

import { parseSearchBankFeedsParams, searchBankFeeds, shapeFeedRow, SEARCH_BANK_FEEDS_MAX_LIMIT } from "@/lib/finance/feed-search-tool"

beforeEach(() => { calls = []; reply = { data: [], error: null } })

describe("parseSearchBankFeedsParams", () => {
  it("needs at least one filter", () => {
    expect(parseSearchBankFeedsParams({})).toEqual({ ok: false, error: expect.stringMatching(/at least one filter/) })
    expect(parseSearchBankFeedsParams({ currency: "EUR", limit: 5 }).ok).toBe(false)
  })
  it("turns the sender text into lower-case words and drops one-letter noise", () => {
    const r = parseSearchBankFeedsParams({ sender: "Simone  Fattor, a" })
    expect(r.ok && r.value.words).toEqual(["simone", "fattor"])
  })
  it("strips anything that could change a filter instead of being searched", () => {
    const r = parseSearchBankFeedsParams({ sender: "x),status.eq.matched,(y %_ a*" })
    expect(r.ok && r.value.words.every((w) => /^[a-z0-9.@'À-ɏ-]+$/.test(w))).toBe(true)
    // What is left of each word is searched as plain text inside the pattern, never read as a filter.
    expect(r.ok && r.value.words.join("")).not.toMatch(/[(),%_*]/)
  })
  it("rejects a bad amount, date or status and caps the limit", () => {
    expect(parseSearchBankFeedsParams({ amount: "abc" }).ok).toBe(false)
    expect(parseSearchBankFeedsParams({ from: "May 29" }).ok).toBe(false)
    expect(parseSearchBankFeedsParams({ sender: "fattor", status: "weird" }).ok).toBe(false)
    const r = parseSearchBankFeedsParams({ sender: "fattor", limit: 9999 })
    expect(r.ok && r.value.limit).toBe(SEARCH_BANK_FEEDS_MAX_LIMIT)
  })
  it("keeps a valid currency (upper-cased), dates and amount", () => {
    const r = parseSearchBankFeedsParams({ amount: "500", currency: "eur", from: "2026-05-01", to: "2026-05-31" })
    expect(r.ok && r.value).toMatchObject({ amount: 500, currency: "EUR", from: "2026-05-01", to: "2026-05-31" })
  })
})

describe("searchBankFeeds", () => {
  it("NEVER asks for TD's private money: outgoing, owner ledger, anything with an owner account", async () => {
    await searchBankFeeds({ sender: "fattor" })
    expect(calls.find((c) => c.method === "not")?.args).toEqual(["status", "in", "(outgoing,owner_ledger)"])
    expect(calls.find((c) => c.method === "is")?.args).toEqual(["owner_account_number", null])
  })

  it("applies each filter it was given", async () => {
    await searchBankFeeds({ sender: "simone fattor", amount: 500, currency: "EUR", from: "2026-05-01", to: "2026-05-31", status: "unmatched", limit: 7 })
    const m = (name: string) => calls.filter((c) => c.method === name).map((c) => c.args)
    expect(m("or")).toHaveLength(2) // one OR (sender/memo) per word → ANDed together
    expect(m("eq")).toEqual(expect.arrayContaining([["amount", 500], ["currency", "EUR"], ["status", "unmatched"]]))
    expect(m("gte")).toEqual([["transaction_date", "2026-05-01"]])
    expect(m("lte")).toEqual([["transaction_date", "2026-05-31"]])
    expect(m("limit")).toEqual([[7]])
  })

  it("returns an error object, never throws, on a bad request or a database error", async () => {
    expect(JSON.parse(await searchBankFeeds({}))).toHaveProperty("error")
    reply = { data: null, error: { message: "boom" } }
    expect(JSON.parse(await searchBankFeeds({ sender: "fattor" })).error).toMatch(/boom/)
  })

  it("returns the shaped rows", async () => {
    reply = { data: [{ id: "f1", source: "stripe", transaction_date: "2026-05-05", amount: "200", currency: "EUR", sender_name: "Luca Comaggi", memo: null, status: "matched", review_metadata: null, payments: null }], error: null }
    const out = JSON.parse(await searchBankFeeds({ sender: "comaggi" }))
    expect(out.total).toBe(1)
    expect(out.results[0]).toMatchObject({ feed_id: "f1", amount: 200, sender: "Luca Comaggi", linked_invoice: null, earlier_investigation: null })
  })
})

describe("shapeFeedRow", () => {
  it("names who the linked invoice belongs to — the company, else the person — and carries an earlier investigation's short result", () => {
    const row = shapeFeedRow({
      id: "f2", source: "stripe", transaction_date: "2026-05-05", amount: 200, currency: "EUR", sender_name: "Luca Comaggi", memo: "m".repeat(500), status: "matched",
      review_metadata: { investigation: { verdict: "likely", summary: "An apostille customer.", at: "2026-10-30T12:00:00Z", story: "long…" } },
      payments: [{ id: "p1", invoice_number: "INV-002084", description: "LLC Formation", invoice_status: "Partial", accounts: null, contacts: { full_name: "Mario Rossi" } }],
    })
    expect(row.linked_invoice).toMatchObject({ invoice_number: "INV-002084", belongs_to: "Mario Rossi" })
    expect(row.earlier_investigation).toEqual({ verdict: "likely", summary: "An apostille customer.", at: "2026-10-30T12:00:00Z" })
    expect(row.memo).toHaveLength(200)
    expect(JSON.stringify(row)).not.toMatch(/long…/) // the full story stays out of this view
  })
})
