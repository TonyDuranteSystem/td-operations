/**
 * The "around the payment date" look of the Bank Feed investigator. The things that must never silently break:
 *  - it uses the REAL dates (client_since / onboarding_date / formation_date, offer_date, call_date) — never
 *    created_at, which for early 2026 is the day the old system was moved in;
 *  - a company is set aside when it is already tied to a payment BY THE COMPANY, BY ITS OWNER, BY THE OWNER'S
 *    OTHER COMPANY, or by ANOTHER BANK LINE — and only for money RECEIVED (not a credit note, not a cancelled one);
 *  - this payment's own bank line is never counted as "another bank line";
 *  - a list that cannot be read is NAMED, never reported as "nothing found", and nothing here ever throws;
 *  - what is kept on the payment is counts, never names.
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
  addDays,
  MAX_LISTED_ASIDE,
  MAX_LISTED_LEFT,
  NEARBY_DAYS_AFTER,
  NEARBY_DAYS_BEFORE,
  nearbyNotRun,
  runNearbySweep,
  SET_ASIDE_DAYS_AFTER,
  summarizeNearby,
  windowAround,
} from "@/lib/finance/feed-nearby-sweep"

const FEED_ID = "228b5a19-9a35-4221-84bc-1226d4a605c0"

describe("windowAround / addDays", () => {
  it("is the days before and after the payment date", () => {
    expect(windowAround("2026-02-13", NEARBY_DAYS_BEFORE, NEARBY_DAYS_AFTER)).toEqual({ from: "2026-01-30", to: "2026-02-20" })
    expect(windowAround("2026-02-13T12:00:00Z", 1, 1)).toEqual({ from: "2026-02-12", to: "2026-02-14" })
  })
  it("is null for a missing or invalid date", () => {
    expect(windowAround(null, 14, 7)).toBeNull()
    expect(windowAround("yesterday", 14, 7)).toBeNull()
    expect(windowAround("2026-13-45", 14, 7)).toBeNull()
  })
  it("adds days across a month end", () => {
    expect(addDays("2026-02-20", SET_ASIDE_DAYS_AFTER)).toBe("2026-03-22")
  })
})

// ── the database half, against a fake ──────────────────────────────────────────────────

interface Call { method: string; args: unknown[] }
interface Entry { table: string; calls: Call[] }
let log: Entry[]
let handler: (table: string, calls: Call[]) => { data: unknown; error: { message: string } | null } | Promise<never>

const fakeDb = {
  from: (table: string) => {
    const calls: Call[] = []
    log.push({ table, calls })
    const q: Record<string, unknown> = new Proxy({}, {
      get(_t, prop) {
        const name = String(prop)
        if (name === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => handler(table, calls)).then(res, rej)
        return (...args: unknown[]) => {
          calls.push({ method: name, args })
          return q
        }
      },
    })
    return q
  },
} as never

const ok = (data: unknown) => ({ data, error: null })
const inColumn = (calls: Call[]) => String(calls.find((c) => c.method === "in")?.args[0] ?? "")
const callsOf = (table: string) => log.filter((e) => e.table === table)

// Companies (generic test names). Dates are the payment date 2026-02-13 ± the window 2026-01-30 .. 2026-02-20.
const A = { alone: "a1", paid: "a2", ownerPaid: "a3", ownerOther: "a4", bankLine: "a5", credit: "a6", cancelled: "a7", otherCo: "a9" }
const P = { three: "p3", four: "p4", lead: "pl" }
const company = (id: string, name: string, onboarding: string) => ({ id, company_name: name, status: "Active", client_since: null, onboarding_date: onboarding, formation_date: onboarding })

const defaultHandler = (table: string, calls: Call[]) => {
  if (table === "accounts") {
    return ok([
      company(A.alone, "Alone Test LLC", "2026-02-11"),
      company(A.paid, "Paid Test LLC", "2026-02-12"),
      company(A.ownerPaid, "OwnerPaid Test LLC", "2026-02-14"),
      company(A.ownerOther, "OwnerOther Test LLC", "2026-02-15"),
      company(A.bankLine, "BankLine Test LLC", "2026-02-16"),
      company(A.credit, "Credit Test LLC", "2026-02-17"),
      company(A.cancelled, "Cancelled Test LLC", "2026-02-18"),
    ])
  }
  if (table === "leads") {
    return ok([
      { id: "l1", full_name: "Unconverted Lead", status: "Offer Sent", call_date: "2026-02-16", converted_to_contact_id: null },
      { id: "l2", full_name: "Converted Lead", status: "Converted", call_date: "2026-02-18", converted_to_contact_id: P.lead },
    ])
  }
  if (table === "offers") {
    return ok([
      { id: "o1", client_name: "Offer For Paid Test", status: "signed", offer_date: "2026-02-12", lead_id: null, contact_id: null, account_id: A.paid },
      { id: "o2", client_name: "Loose Offer", status: "sent", offer_date: "2026-02-19", lead_id: null, contact_id: null, account_id: null },
    ])
  }
  if (table === "account_contacts") {
    if (inColumn(calls) === "account_id") return ok([{ account_id: A.ownerPaid, contact_id: P.three }, { account_id: A.ownerOther, contact_id: P.four }])
    return ok([{ account_id: A.ownerPaid, contact_id: P.three }, { account_id: A.ownerOther, contact_id: P.four }, { account_id: A.otherCo, contact_id: P.four }])
  }
  if (table === "payments") {
    const column = inColumn(calls)
    if (column === "account_id") {
      return ok([
        { id: "pay-paid", account_id: A.paid, contact_id: null, status: "Paid", invoice_status: null, amount: 2500, amount_currency: "EUR", paid_date: "2026-02-19", invoice_number: "INV-000001" },
        { id: "pay-other", account_id: A.otherCo, contact_id: null, status: "Paid", invoice_status: "Paid", amount: 1000, amount_currency: "USD", paid_date: "2026-02-20", invoice_number: null },
        // a credit note: "Paid" but NEGATIVE — money paid out. Must not set its company aside (two shapes of it).
        { id: "pay-credit", account_id: A.credit, contact_id: null, status: "Paid", invoice_status: "Credit", amount: -300, amount_currency: "USD", paid_date: "2026-02-18", invoice_number: "CN-000001" },
        { id: "pay-credit2", account_id: A.credit, contact_id: null, status: "Paid", invoice_status: null, amount: -250, amount_currency: "USD", paid_date: "2026-02-18", invoice_number: "CN-000002" },
        // cancelled: not money received.
        { id: "pay-cancel", account_id: A.cancelled, contact_id: null, status: "Cancelled", invoice_status: null, amount: 1500, amount_currency: "USD", paid_date: "2026-02-18", invoice_number: null },
      ])
    }
    if (column === "contact_id") {
      return ok([
        { id: "pay-p3", account_id: null, contact_id: P.three, status: "Paid", invoice_status: null, amount: 3000, amount_currency: "EUR", paid_date: "2026-02-13", invoice_number: "INV-000003" },
        { id: "pay-pl", account_id: null, contact_id: P.lead, status: "Paid", invoice_status: null, amount: 900, amount_currency: "USD", paid_date: "2026-02-19", invoice_number: null },
      ])
    }
    // the payments another bank line points at
    return ok([{ id: "pay-bank", account_id: A.bankLine, contact_id: null, status: "Paid", invoice_status: null, amount: 3000, amount_currency: "EUR", paid_date: "2026-04-04", invoice_number: "INV-000009" }])
  }
  if (table === "td_bank_feeds") return ok([{ id: "other-feed", matched_payment_id: "pay-bank", review_metadata: {} }])
  return ok([])
}

beforeEach(() => {
  log = []
  handler = defaultHandler
})

const run = () => runNearbySweep({ facts: { transaction_date: "2026-02-13" }, feedId: FEED_ID, db: fakeDb })
const byName = <T extends { name: string }>(items: T[], name: string): T | undefined => items.find((i) => i.name === name)

describe("runNearbySweep — what is set aside, and why", () => {
  it("lists what is left and sets aside what is already tied to a payment, by company, owner, owner's other company, bank line", async () => {
    const sweep = await run()
    expect(sweep.ran).toBe(true)
    expect(sweep.error).toBeNull()
    expect(sweep.window).toEqual({ from: "2026-01-30", to: "2026-02-20" })

    const left = sweep.items.filter((i) => !i.setAside).map((i) => i.name)
    expect(left).toEqual(["Alone Test LLC", "Unconverted Lead", "Credit Test LLC", "Cancelled Test LLC", "Loose Offer"])

    const reason = (name: string) => byName(sweep.items, name)?.setAside ?? ""
    expect(reason("Paid Test LLC")).toContain("2500 EUR paid on 2026-02-19")
    expect(reason("Paid Test LLC")).toContain("INV-000001")
    expect(reason("OwnerPaid Test LLC")).toContain("3000 EUR paid on 2026-02-13")
    expect(reason("OwnerPaid Test LLC")).toContain("through its owner")
    expect(reason("OwnerOther Test LLC")).toContain("1000 USD paid on 2026-02-20")
    expect(reason("OwnerOther Test LLC")).toContain("on another company of the same person")
    expect(reason("BankLine Test LLC")).toContain("another bank line is tied to their payment INV-000009")
    expect(reason("Converted Lead")).toContain("900 USD paid on 2026-02-19")
    expect(reason("Offer For Paid Test")).toContain("2500 EUR paid on 2026-02-19")
  })

  it("a credit note (negative) and a cancelled payment do NOT set a company aside", async () => {
    const sweep = await run()
    expect(byName(sweep.items, "Credit Test LLC")?.setAside).toBeNull()
    expect(byName(sweep.items, "Cancelled Test LLC")?.setAside).toBeNull()
  })

  it("counts every kind and the set-aside total", async () => {
    const sweep = await run()
    expect(sweep.totals).toEqual({ companies: 7, calls: 2, offers: 2, set_aside: 6, left: 5 })
  })

  it("uses the real date fields, never created_at", async () => {
    await run()
    const accounts = callsOf("accounts")[0]
    const or = String(accounts.calls.find((c) => c.method === "or")?.args[0])
    for (const column of ["client_since", "onboarding_date", "formation_date"]) expect(or).toContain(column)
    expect(JSON.stringify(accounts.calls)).not.toContain("created_at")
    expect(callsOf("leads")[0].calls.some((c) => c.method === "gte" && c.args[0] === "call_date" && c.args[1] === "2026-01-30")).toBe(true)
    expect(callsOf("offers")[0].calls.some((c) => c.method === "lte" && c.args[0] === "offer_date" && c.args[1] === "2026-02-20")).toBe(true)
  })

  it("counts payments only in the window plus 30 days, never test payments", async () => {
    await run()
    const payments = callsOf("payments").filter((e) => ["account_id", "contact_id"].includes(inColumn(e.calls)))
    expect(payments.length).toBe(2)
    for (const e of payments) {
      expect(e.calls.some((c) => c.method === "gte" && c.args[0] === "paid_date" && c.args[1] === "2026-01-30")).toBe(true)
      expect(e.calls.some((c) => c.method === "lte" && c.args[0] === "paid_date" && c.args[1] === "2026-03-22")).toBe(true)
      expect(e.calls.some((c) => c.method === "not" && c.args[0] === "is_test")).toBe(true)
    }
  })

  it("never counts this payment's own bank line as 'another bank line'", async () => {
    await run()
    const feeds = callsOf("td_bank_feeds")[0]
    expect(feeds.calls.some((c) => c.method === "neq" && c.args[0] === "id" && c.args[1] === FEED_ID)).toBe(true)
    expect(feeds.calls.some((c) => c.method === "eq" && c.args[0] === "status" && c.args[1] === "matched")).toBe(true)
  })

  it("a bank line that ties several invoices (the multi-invoice record) sets each of them aside", async () => {
    handler = (table, calls) => {
      if (table === "td_bank_feeds") return ok([{ id: "f", matched_payment_id: null, review_metadata: { multi_audit_link: true, linked_payment_ids: ["pay-bank"] } }])
      return defaultHandler(table, calls)
    }
    const sweep = await run()
    expect(byName(sweep.items, "BankLine Test LLC")?.setAside).toContain("another bank line")
  })
})

describe("runNearbySweep — it never lies about what it could not read", () => {
  it("a list that fails is named, the others still answer, and nothing is reported as 'none found'", async () => {
    handler = (table, calls) => (table === "leads" ? { data: null, error: { message: "relation is down" } } : defaultHandler(table, calls))
    const sweep = await run()
    expect(sweep.ran).toBe(true)
    expect(sweep.error).toContain("calls: relation is down")
    expect(sweep.items.some((i) => i.kind === "company")).toBe(true)
    expect(sweep.totals.calls).toBe(0)
  })

  it("if the set-aside check fails, the error says so (the list is then NOT filtered)", async () => {
    handler = (table, calls) => (table === "payments" ? { data: null, error: { message: "timeout" } } : defaultHandler(table, calls))
    const sweep = await run()
    expect(sweep.error).toContain("their payments: timeout")
    // Nothing could be set aside, so those companies stay in the list instead of vanishing.
    expect(byName(sweep.items, "Paid Test LLC")?.setAside ?? null).toBeNull()
  })

  it("when none of the three first lists can be read, it did not run", async () => {
    handler = () => ({ data: null, error: { message: "down" } })
    const sweep = await run()
    expect(sweep.ran).toBe(false)
    expect(sweep.items).toEqual([])
    expect(sweep.error).toContain("companies: down")
  })

  it("never throws, even when the database itself throws", async () => {
    handler = () => Promise.reject(new Error("boom"))
    const sweep = await run()
    expect(sweep.ran).toBe(false)
    expect(sweep.error).toContain("boom")
  })

  it("a payment with no usable date is not looked at, and nothing is read", async () => {
    const sweep = await runNearbySweep({ facts: { transaction_date: null }, feedId: FEED_ID, db: fakeDb })
    expect(sweep).toEqual(nearbyNotRun("the payment has no usable date"))
    expect(log).toEqual([])
  })
})

describe("runNearbySweep — size", () => {
  it("lists a capped number but counts them all", async () => {
    handler = (table, calls) => {
      if (table === "accounts") return ok(Array.from({ length: 40 }, (_, i) => company(`x${i}`, `Many ${String(i).padStart(2, "0")} LLC`, "2026-02-14")))
      if (table === "leads" || table === "offers") return ok([])
      return defaultHandler(table, calls)
    }
    // no payments / owners → none set aside
    handler = ((inner) => (table: string, calls: Call[]) => (["payments", "account_contacts", "td_bank_feeds"].includes(table) ? ok([]) : inner(table, calls)))(handler)
    const sweep = await run()
    expect(sweep.totals.left).toBe(40)
    expect(sweep.items.filter((i) => !i.setAside)).toHaveLength(MAX_LISTED_LEFT)
    expect(sweep.items.filter((i) => i.setAside).length).toBeLessThanOrEqual(MAX_LISTED_ASIDE)
  })

  it("asks for ids in chunks, never one huge list", async () => {
    handler = (table, calls) => {
      if (table === "accounts") return ok(Array.from({ length: 120 }, (_, i) => company(`y${i}`, `Chunk ${i} LLC`, "2026-02-14")))
      if (table === "leads" || table === "offers") return ok([])
      return defaultHandler(table, calls)
    }
    await run()
    const owners = callsOf("account_contacts").filter((e) => inColumn(e.calls) === "account_id")
    expect(owners.length).toBe(3)
    for (const e of owners) expect((e.calls.find((c) => c.method === "in")?.args[1] as string[]).length).toBeLessThanOrEqual(50)
  })
})

describe("summarizeNearby", () => {
  it("keeps counts and the window, never the names", async () => {
    const summary = summarizeNearby(await run())
    expect(summary).toEqual({ ran: true, window: { from: "2026-01-30", to: "2026-02-20" }, error: null, companies: 7, calls: 2, offers: 2, set_aside: 6, left: 5 })
    expect(JSON.stringify(summary)).not.toContain("Test LLC")
  })
})
