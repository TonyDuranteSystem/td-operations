/**
 * Which invoices the Match popup offers for one bank transaction.
 *
 * The real case: a $125 Stripe payment from "Bilaal Rajan" whose email is not in the CRM; seven
 * earlier payments from the same sender were linked to one company, and two of its invoices ($50 +
 * $75, both already Paid on the payment's date) add up to the payment exactly. Delete the history
 * lookup and the first test fails; delete the rail guard and the "Wise" test fails; delete the
 * owner-private check and the privacy test fails.
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

import { loadPayerInvoices } from "@/lib/finance/payer-invoices"

const has = (calls: Call[], method: string, pred?: (args: unknown[]) => boolean) =>
  calls.some((c) => c.method === method && (!pred || pred(c.args)))
const arg = (calls: Call[], method: string, i = 0) => calls.find((c) => c.method === method)?.args[i]

const FEED = {
  id: "feed1",
  sender_name: "Bilaal Rajan",
  sender_reference: null,
  raw_data: null,
  memo: "email: rajan.aman@gmail.com | visa ••••9765",
  amount: 125,
  currency: "USD",
  transaction_date: "2026-06-16T14:03:00Z",
  status: "unmatched",
  owner_account_number: null,
}

const inv = (id: string, number: string, total: number, over: Record<string, unknown> = {}) => ({
  id, invoice_number: number, description: `desc ${number}`, installment: null, total, amount: total,
  amount_due: null, amount_paid: total, amount_currency: "USD", invoice_status: "Paid", status: "Paid",
  paid_date: "2026-06-16", account_id: "acctA", contact_id: null, is_test: false,
  accounts: { company_name: "Simple Holdings USA Inc" }, contacts: null, ...over,
})

let feedRow: Record<string, unknown> | null
let historyByName: unknown[]
let historyByMemo: unknown[]
let emailContacts: unknown[]
let accountLinks: unknown[]
let invoices: unknown[]
let pointedClaims: unknown[]
let multiClaims: unknown[]
let appClaims: unknown[]

const histRow = (id: string, memo: string, account = "acctA", date = "2026-07-01", name = "Bilaal Rajan") => ({
  id, sender_name: name, memo, transaction_date: date, payments: { account_id: account, contact_id: null },
})

beforeEach(() => {
  log.length = 0
  feedRow = { ...FEED }
  historyByName = Array.from({ length: 7 }, (_, i) => histRow(`h${i}`, "email: rajan.aman@gmail.com | visa", "acctA", `2026-0${i + 1}-10`))
  historyByMemo = []
  emailContacts = []
  accountLinks = []
  invoices = [
    inv("p323", "INV-002323", 50),
    inv("p121", "INV-002121", 75),
    inv("p402", "INV-002402", 50, { paid_date: "2026-07-14" }),
    inv("open1", "INV-002600", 200, { invoice_status: "Sent", status: "Pending", paid_date: null, amount_paid: 0, amount_due: 200 }),
  ]
  pointedClaims = [{ matched_payment_id: "p402" }]
  multiClaims = []
  appClaims = []
  handler = (table, calls) => {
    if (table === "td_bank_feeds") {
      if (has(calls, "maybeSingle")) return { data: feedRow }
      if (has(calls, "ilike", (a) => a[0] === "sender_name")) return { data: historyByName }
      if (has(calls, "ilike", (a) => a[0] === "memo")) return { data: historyByMemo }
      if (has(calls, "eq", (a) => a[0] === "review_metadata->>multi_audit_link")) return { data: multiClaims }
      if (has(calls, "in", (a) => a[0] === "matched_payment_id")) return { data: pointedClaims }
    }
    if (table === "contacts") {
      if (has(calls, "ilike", (a) => a[0] === "email")) return { data: emailContacts }
      return { data: [] }
    }
    if (table === "account_contacts") return { data: accountLinks }
    if (table === "accounts") return { data: [{ id: "acctA", company_name: "Simple Holdings USA Inc" }] }
    if (table === "payments") return { data: has(calls, "eq", (a) => a[0] === "account_id") ? invoices : [] }
    if (table === "payment_applications") return { data: appClaims }
    return { data: [] }
  }
})

const run = (over: Partial<Parameters<typeof loadPayerInvoices>[0]> = {}) =>
  loadPayerInvoices({ feedId: "feed1", isOwner: false, ...over })

describe("loadPayerInvoices — the $125 = $50 + $75 case", () => {
  it("finds the company from earlier payments and offers the two invoices as an exact sum", async () => {
    const r = await run()
    expect(r.ok).toBe(true)
    expect(r.companies).toEqual([
      expect.objectContaining({ kind: "account", id: "acctA", name: "Simple Holdings USA Inc", source: "history", times_linked: 7 }),
    ])
    expect(r.combos?.[0]).toMatchObject({ total: 125, dates_match: true })
    expect(r.combos?.[0].ids.slice().sort()).toEqual(["p121", "p323"])
  })

  it("lists every invoice, unpaid first, with the paid date", async () => {
    const r = await run()
    expect(r.invoices?.map((i) => i.invoice_number)).toEqual(["INV-002600", "INV-002402", "INV-002323", "INV-002121"])
    expect(r.invoices?.[0]).toMatchObject({ invoice_number: "INV-002600", paid: false, balance: 200 })
    expect(r.invoices?.find((i) => i.id === "p323")).toMatchObject({ paid: true, paid_date: "2026-06-16", total: 50 })
  })

  it("never offers a set that mixes paid and unpaid invoices — those cannot be linked in one step", async () => {
    invoices = [
      inv("paid50", "INV-1", 50),
      inv("open75", "INV-2", 75, { invoice_status: "Sent", status: "Pending", amount_paid: 0, amount_due: 75, paid_date: null }),
    ]
    expect((await run()).combos).toEqual([])
  })

  it("offers a set of unpaid invoices that adds up, without claiming they were paid around the payment's date", async () => {
    const owed = (id: string, n: string, t: number) => inv(id, n, t, { invoice_status: "Sent", status: "Pending", amount_paid: 0, amount_due: t, paid_date: null })
    invoices = [owed("o50", "INV-1", 50), owed("o75", "INV-2", 75)]
    const r = await run()
    expect(r.combos?.[0].ids.slice().sort()).toEqual(["o50", "o75"])
    expect(r.combos?.[0].dates_match).toBe(false)
  })

  it("marks a PAID invoice tied to another transaction, and never suggests it", async () => {
    invoices = [inv("p402", "INV-002402", 75, { paid_date: "2026-06-16" }), inv("p323", "INV-002323", 50)]
    const r = await run()
    expect(r.invoices?.find((i) => i.id === "p402")?.claimed_by_other).toBe(true)
    expect(r.combos).toEqual([])
  })

  it("only asks about claims for PAID invoices — an unpaid one still owed is a normal target", async () => {
    await run()
    const claimQuery = log.find((l) => l.table === "td_bank_feeds" && has(l.calls, "in", (a) => a[0] === "matched_payment_id"))
    const asked = (arg(claimQuery!.calls, "in", 1) as string[]).slice().sort()
    expect(asked).toEqual(["p121", "p323", "p402"])
    expect(asked).not.toContain("open1")
  })

  it("reads claims made through a multi-link and through the ledger, excluding this transaction", async () => {
    pointedClaims = []
    multiClaims = [{ review_metadata: { multi_audit_link: true, linked_payment_ids: ["p323", "p121"] } }]
    const r = await run()
    expect(r.invoices?.filter((i) => i.claimed_by_other).map((i) => i.id).sort()).toEqual(["p121", "p323"])

    multiClaims = []
    appClaims = [{ payment_id: "p121" }]
    const r2 = await run()
    expect(r2.invoices?.filter((i) => i.claimed_by_other).map((i) => i.id)).toEqual(["p121"])
    const ledger = log.filter((l) => l.table === "payment_applications").at(-1)!
    expect(has(ledger.calls, "neq", (a) => a[0] === "feed_id" && a[1] === "feed1")).toBe(true)
  })
})

describe("loadPayerInvoices — who the payer is", () => {
  it("puts the company the billing email belongs to in the CRM first", async () => {
    emailContacts = [{ id: "c1" }]
    accountLinks = [{ account_id: "acctA" }]
    historyByName = []
    const r = await run()
    expect(r.companies?.[0]).toMatchObject({ id: "acctA", source: "email" })
  })

  it("does not use a sender name that is only a payment rail", async () => {
    feedRow = { ...FEED, sender_name: "WISE US INC", memo: null }
    const r = await run()
    expect(r.ok).toBe(true)
    expect(r.companies).toEqual([])
    expect(log.some((l) => l.table === "td_bank_feeds" && has(l.calls, "ilike", (a) => a[0] === "sender_name"))).toBe(false)
  })

  it("does not use a missing or 'Unknown' sender name", async () => {
    feedRow = { ...FEED, sender_name: "Unknown", memo: null }
    expect((await run()).companies).toEqual([])
    feedRow = { ...FEED, sender_name: null, memo: null }
    expect((await run()).companies).toEqual([])
  })

  it("counts an earlier payment only when it is the same sender or the very same email — not one that merely contains it", async () => {
    historyByName = [
      histRow("same", "x", "acctA", "2026-05-01", "  BILAAL   rajan "),
      histRow("other", "x", "acctB", "2026-05-02", "Bilaal Rajan Jr"),
    ]
    feedRow = { ...FEED, memo: "email: ann@x.com" }
    historyByMemo = [
      histRow("superstring", "email: joann@x.com", "acctB", "2026-05-03", "Someone Else"),
      histRow("exact", "email: ANN@x.com | visa", "acctA", "2026-05-04", "Someone Else"),
    ]
    const r = await run()
    expect(r.companies).toEqual([expect.objectContaining({ id: "acctA", times_linked: 2, source: "history" })])
  })

  it("never counts an earlier payment that carries an owner account number", async () => {
    await run()
    const q = log.find((l) => l.table === "td_bank_feeds" && has(l.calls, "ilike", (a) => a[0] === "sender_name"))!
    expect(has(q.calls, "is", (a) => a[0] === "owner_account_number" && a[1] === null)).toBe(true)
    expect(has(q.calls, "eq", (a) => a[0] === "status" && a[1] === "matched")).toBe(true)
    expect(has(q.calls, "neq", (a) => a[0] === "id" && a[1] === "feed1")).toBe(true)
  })

  it("lists a searched company directly, without reading anyone's history", async () => {
    const r = await run({ accountId: "acctA" })
    expect(r.companies).toEqual([expect.objectContaining({ id: "acctA", source: "search", times_linked: 0 })])
    expect(log.some((l) => l.table === "td_bank_feeds" && has(l.calls, "ilike"))).toBe(false)
  })

  it("returns nothing, not an error, when no company can be found", async () => {
    historyByName = []
    const r = await run()
    expect(r).toMatchObject({ ok: true, companies: [], invoices: [], combos: [] })
  })

  it("escapes LIKE wildcards in the sender's name", async () => {
    feedRow = { ...FEED, sender_name: "100%_Real Person" }
    historyByName = []
    await run()
    const q = log.find((l) => l.table === "td_bank_feeds" && has(l.calls, "ilike", (a) => a[0] === "sender_name"))!
    expect(arg(q.calls, "ilike", 1)).toBe("%100\\%\\_real person%")
  })
})

describe("loadPayerInvoices — which invoices may be offered", () => {
  it("leaves out test, voided, cancelled, credit, split and refunded invoices", async () => {
    invoices = [
      inv("keep", "INV-1", 50),
      inv("test", "INV-2", 50, { is_test: true }),
      inv("void", "INV-3", 50, { invoice_status: "Voided", status: "Cancelled" }),
      inv("credit", "INV-4", 50, { invoice_status: "Credit", status: "Paid" }),
      inv("split", "INV-5", 50, { invoice_status: "Split", status: "Pending" }),
      inv("refunded", "INV-6", 50, { invoice_status: "Paid", status: "Refunded" }),
    ]
    const r = await run()
    expect(r.invoices?.map((i) => i.id)).toEqual(["keep"])
  })

  it("treats an invoice paid only through the coarse status column as paid", async () => {
    invoices = [inv("quiet", "INV-7", 50, { invoice_status: null, status: "Paid" })]
    expect((await run()).invoices?.[0]).toMatchObject({ paid: true })
  })

  it("uses the amount column when an invoice has no total", async () => {
    invoices = [inv("notot", "INV-8", 75, { total: null })]
    expect((await run()).invoices?.[0]).toMatchObject({ total: 75 })
  })

  it("shows what is still owed on a part-paid invoice: the total less what was received", async () => {
    invoices = [inv("part", "INV-9", 500, { invoice_status: "Partial", status: "Pending", amount_paid: 200, amount_due: null, paid_date: null })]
    expect((await run()).invoices?.[0]).toMatchObject({ paid: false, balance: 300, status_label: "Partial" })
    // The amount_due column is not trusted: older writers never kept it up to date.
    invoices = [inv("stale", "INV-10", 500, { invoice_status: "Partial", status: "Pending", amount_paid: 200, amount_due: 500, paid_date: null })]
    expect((await run()).invoices?.[0]).toMatchObject({ balance: 300 })
  })
})

describe("loadPayerInvoices — refusals", () => {
  it("says so when the transaction does not exist", async () => {
    feedRow = null
    expect(await run()).toMatchObject({ ok: false, error: "Transaction not found." })
  })

  it("hides TD's own private money from anyone but the owner", async () => {
    for (const priv of [{ status: "outgoing" }, { status: "owner_ledger" }, { owner_account_number: "1234" }]) {
      feedRow = { ...FEED, ...priv }
      expect(await run({ isOwner: false })).toMatchObject({ ok: false, error: "Transaction not found." })
      expect((await run({ isOwner: true })).ok).toBe(true)
    }
  })

  it("fails loudly rather than guessing when the history cannot be read", async () => {
    const base = handler
    handler = (table, calls) => (table === "td_bank_feeds" && has(calls, "ilike") ? { data: null, error: { message: "boom" } } : base(table, calls))
    expect(await run()).toMatchObject({ ok: false })
  })

  it("fails loudly rather than guessing when the claims cannot be read", async () => {
    const base = handler
    handler = (table, calls) => (table === "payment_applications" ? { data: null, error: { message: "boom" } } : base(table, calls))
    expect(await run()).toMatchObject({ ok: false })
  })
})
