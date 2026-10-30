/**
 * The chats-and-notes search of the Bank Feed investigator. The things that must never silently break:
 *  - the payer's name is cut out of a bank line that also carries an invoice reference;
 *  - an invoice number is searched in every way a person writes it ("INV 2026 001" finds "INV-2026-001");
 *  - deleted messages are never read, and team chat is read in channels and discussions ONLY (never a direct
 *    message or a group), and staff notes only as the person running it may see them;
 *  - a place that cannot be searched is NAMED as not searched, never reported as "nothing found";
 *  - what is kept on the payment is counts, never the text.
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
  CHAT_STORES,
  chatSearchTerms,
  chatWindow,
  invoiceNumberVariants,
  mergeHits,
  payerNameCore,
  runChatSweep,
  summarizeChatSweep,
  TEAM_CHAT_OPEN_THREAD_TYPES,
  type ChatHit,
} from "@/lib/finance/feed-chat-sweep"
import { visibleToOrClause } from "@/lib/notes/staff-notes"

const USER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"
const ACCOUNT_ID = "5cf70c1f-d79f-4a1d-81f5-7a445d4a3de9"

describe("payerNameCore", () => {
  it("cuts the invoice reference off the name", () => {
    expect(payerNameCore("Active Acres Properties LLC - INV 2026 001")).toBe("Active Acres Properties LLC")
    expect(payerNameCore("ACME LLC — Invoice 1234")).toBe("ACME LLC")
  })
  it("keeps a plain name as it is, and reads Wise-style lines", () => {
    expect(payerNameCore("2L CONSULTING LLC")).toBe("2L CONSULTING LLC")
    expect(payerNameCore("Payment from Jane Roe via WISE")).toBe("Jane Roe")
  })
  it("never throws on nothing", () => {
    expect(payerNameCore(null)).toBe("")
    expect(payerNameCore(undefined)).toBe("")
  })
})

describe("invoiceNumberVariants", () => {
  it("finds a number written with spaces and offers the dashed form too", () => {
    expect(invoiceNumberVariants("Active Acres - INV 2026 001")).toEqual(["INV-2026-001", "INV 2026 001"])
  })
  it("finds a glued number and a long invoice word", () => {
    expect(invoiceNumberVariants("inv001389")).toEqual(["INV-001389", "INV 001389"])
    expect(invoiceNumberVariants("Invoice #1234 paid")).toEqual(["INV-1234", "INV 1234"])
  })
  it("finds several numbers, once each", () => {
    const v = invoiceNumberVariants("INV-2026-001 and INV-001389 and INV-2026-001 again")
    expect(v).toContain("INV-2026-001")
    expect(v).toContain("INV-001389")
    expect(new Set(v.map((x) => x.toLowerCase())).size).toBe(v.length)
  })
  it("finds nothing where there is no number", () => {
    expect(invoiceNumberVariants("Zelle ACTIVE ACRES PRO")).toEqual([])
    expect(invoiceNumberVariants("INV only")).toEqual([])
    expect(invoiceNumberVariants(null)).toEqual([])
  })
  it("never returns more than six", () => {
    const many = Array.from({ length: 10 }, (_, i) => `INV-${1000 + i}`).join(" ")
    expect(invoiceNumberVariants(many).length).toBeLessThanOrEqual(6)
  })
})

describe("chatSearchTerms", () => {
  it("is the name, the invoice number in both forms, and the memo's email", () => {
    const terms = chatSearchTerms({ sender_name: "Active Acres Properties LLC - INV 2026 001", memo: "email: pay@activeacres.com" })
    expect(terms).toEqual(["Active Acres Properties LLC", "pay@activeacres.com", "INV-2026-001", "INV 2026 001"])
  })
  it("leaves out a name that identifies nobody", () => {
    expect(chatSearchTerms({ sender_name: "Unknown", memo: null })).toEqual([])
    expect(chatSearchTerms({ sender_name: "AB", memo: null })).toEqual([])
  })
  it("strips quotes and control characters before they can reach a search pattern", () => {
    const terms = chatSearchTerms({ sender_name: 'Evil "Co"\u0000 LLC', memo: null })
    expect(terms[0]).toBe("Evil Co LLC")
  })
  it("never has more than six, and no duplicates", () => {
    const memo = Array.from({ length: 10 }, (_, i) => `INV-${1000 + i}`).join(" ")
    const terms = chatSearchTerms({ sender_name: "Some Real Company LLC", memo })
    expect(terms.length).toBeLessThanOrEqual(6)
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length)
  })
})

describe("chatWindow", () => {
  it("is the days before and after", () => {
    expect(chatWindow("2026-04-02", 30)).toEqual({ from: "2026-03-03", to: "2026-05-02" })
    expect(chatWindow("2026-04-02T12:00:00Z", 1)).toEqual({ from: "2026-04-01", to: "2026-04-03" })
  })
  it("is null for a missing or invalid date", () => {
    expect(chatWindow(null, 30)).toBeNull()
    expect(chatWindow("not a date", 30)).toBeNull()
    expect(chatWindow("2026-13-45", 30)).toBeNull()
  })
})

const hit = (over: Partial<ChatHit>): ChatHit => ({ store: "portal_chat", id: "a", date: "2026-04-01", who: "client", text: "hello", how: "text", ...over })

describe("mergeHits", () => {
  it("keeps one hit per id, newest first", () => {
    const merged = mergeHits([hit({ id: "a", date: "2026-04-01" }), hit({ id: "b", date: "2026-04-05" }), hit({ id: "a", date: "2026-04-09", how: "client" })])
    expect(merged.map((h) => h.id)).toEqual(["b", "a"])
    expect(merged.find((h) => h.id === "a")?.date).toBe("2026-04-01")
  })
  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => hit({ id: `m${i}`, date: `2026-04-${String((i % 28) + 1).padStart(2, "0")}` }))
    expect(mergeHits(many, 5)).toHaveLength(5)
  })
  it("drops a hit with no id", () => {
    expect(mergeHits([hit({ id: "" })])).toEqual([])
  })
})

// ── the database half, against a fake ──────────────────────────────────────────────────

interface Call { method: string; args: unknown[] }
interface Entry { table: string; calls: Call[] }
let log: Entry[]
let handler: (table: string, calls: Call[]) => { data: unknown; error: { message: string } | null }

const fakeDb = {
  from: (table: string) => {
    const calls: Call[] = []
    log.push({ table, calls })
    const q: Record<string, unknown> = new Proxy({}, {
      get(_t, prop) {
        const name = String(prop)
        if (name === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(handler(table, calls)).then(res, rej)
        return (...args: unknown[]) => {
          calls.push({ method: name, args })
          return q
        }
      },
    })
    return q
  },
} as never

const FACTS = { transaction_date: "2026-04-02", sender_name: "Active Acres Properties LLC - INV 2026 001", memo: "Active Acres Properties LLC - INV 2026 001" }

const defaultHandler = (table: string) => {
  if (table === "accounts") return { data: [{ id: ACCOUNT_ID, company_name: "Active Acres Properties LLC" }], error: null }
  if (table === "portal_messages") return { data: [{ id: "pm1", created_at: "2026-04-16T10:00:00Z", sender_type: "client", sender_name: "Harsh Patel", message: "by the way there are no invoices due right?" }], error: null }
  return { data: [], error: null }
}

const callsOf = (table: string) => log.filter((e) => e.table === table)
const hasCall = (entry: Entry, method: string, ...args: unknown[]) => entry.calls.some((c) => c.method === method && JSON.stringify(c.args) === JSON.stringify(args))

beforeEach(() => {
  log = []
  handler = defaultHandler
})

describe("runChatSweep", () => {
  it("reads the matched client's chat around the payment date, and searches the words as well", async () => {
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    expect(sweep.clients).toEqual([{ kind: "account", id: ACCOUNT_ID, name: "Active Acres Properties LLC" }])
    expect(sweep.window).toEqual({ from: "2026-03-03", to: "2026-05-02" })

    const portal = callsOf("portal_messages")
    // client-first: by the company's id, inside the window
    expect(portal.some((e) => hasCall(e, "in", "account_id", [ACCOUNT_ID]))).toBe(true)
    expect(portal.some((e) => e.calls.some((c) => c.method === "gte" && c.args[0] === "created_at"))).toBe(true)
    // by words: the name and the number in both forms
    for (const term of ["Active Acres Properties LLC", "INV-2026-001", "INV 2026 001"]) {
      expect(portal.some((e) => hasCall(e, "ilike", "message", `%${term}%`))).toBe(true)
    }
    const found = sweep.stores.find((s) => s.store === "portal_chat")!
    expect(found.searched).toBe(true)
    expect(found.hits.map((h) => h.id)).toEqual(["pm1"])
    expect(found.hits[0].who).toBe("Harsh Patel")
  })

  it("covers all five places, each by its own label", async () => {
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    expect(sweep.stores.map((s) => s.store)).toEqual([...CHAT_STORES])
    expect(sweep.stores.every((s) => s.label.length > 0)).toBe(true)
  })

  it("never reads a deleted message", async () => {
    await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    for (const table of ["portal_messages", "messages", "internal_messages"]) {
      const entries = callsOf(table)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.every((e) => hasCall(e, "is", "deleted_at", null))).toBe(true)
    }
  })

  it("reads team chat in channels and discussions only — never a direct message or a group", async () => {
    await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const team = callsOf("internal_messages")
    expect(team.length).toBeGreaterThan(0)
    expect(team.every((e) => hasCall(e, "in", "internal_threads.thread_type", [...TEAM_CHAT_OPEN_THREAD_TYPES]))).toBe(true)
    expect(TEAM_CHAT_OPEN_THREAD_TYPES).not.toContain("dm")
    expect(TEAM_CHAT_OPEN_THREAD_TYPES).not.toContain("group")
  })

  it("reads staff notes only as the person running it may see them", async () => {
    await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const notes = callsOf("staff_notes")
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((e) => hasCall(e, "or", visibleToOrClause(USER_ID)))).toBe(true)
  })

  it("escapes search wildcards in what a payer wrote", async () => {
    await runChatSweep({ facts: { transaction_date: "2026-04-02", sender_name: "100%_Real Company LLC", memo: null }, userId: USER_ID, db: fakeDb })
    expect(callsOf("portal_messages").some((e) => e.calls.some((c) => c.method === "ilike" && String(c.args[1]).includes("100\\%\\_Real Company LLC")))).toBe(true)
  })

  it("names a place that failed instead of reporting 'nothing found', and the others still answer", async () => {
    handler = (table) => (table === "messages" ? { data: null, error: { message: "relation is down" } } : defaultHandler(table))
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const whatsapp = sweep.stores.find((s) => s.store === "whatsapp_telegram")!
    expect(whatsapp.searched).toBe(false)
    expect(whatsapp.error).toContain("relation is down")
    expect(sweep.stores.find((s) => s.store === "portal_chat")!.searched).toBe(true)
  })

  it("a place where only SOME searches worked is not reported as searched, and keeps what it found", async () => {
    handler = (table, calls) => {
      if (table === "portal_messages" && calls.some((c) => c.method === "ilike" && String(c.args[1]).includes("INV-2026-001"))) return { data: null, error: { message: "timeout" } }
      return defaultHandler(table)
    }
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const portal = sweep.stores.find((s) => s.store === "portal_chat")!
    expect(portal.searched).toBe(false)
    expect(portal.error).toMatch(/only \d+ of \d+ searches worked/)
    expect(portal.hits.length).toBeGreaterThan(0)
  })

  it("still searches the words when the CRM cannot say who the payer is", async () => {
    handler = (table) => (table === "accounts" ? { data: null, error: { message: "accounts unavailable" } } : defaultHandler(table))
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    expect(sweep.clients).toEqual([])
    expect(sweep.clientLookupError).toContain("accounts unavailable")
    expect(callsOf("portal_messages").some((e) => e.calls.some((c) => c.method === "ilike"))).toBe(true)
  })

  it("says NOT searched everywhere when nothing in the payment can be searched for", async () => {
    handler = () => ({ data: [], error: null })
    const sweep = await runChatSweep({ facts: { transaction_date: "2026-04-02", sender_name: "Unknown", memo: null }, userId: USER_ID, db: fakeDb })
    expect(sweep.terms).toEqual([])
    expect(sweep.stores.every((s) => s.searched === false && s.hits.length === 0)).toBe(true)
    expect(sweep.stores[0].error).toMatch(/nothing in this payment/)
  })

  it("without a payment date it still searches the words (no window)", async () => {
    const sweep = await runChatSweep({ facts: { ...FACTS, transaction_date: null }, userId: USER_ID, db: fakeDb })
    expect(sweep.window).toBeNull()
    expect(callsOf("portal_messages").some((e) => e.calls.some((c) => c.method === "ilike"))).toBe(true)
    expect(callsOf("portal_messages").every((e) => !e.calls.some((c) => c.method === "gte"))).toBe(true)
  })

  it("a query that THROWS is a failed place, not a crash", async () => {
    handler = (table) => {
      if (table === "conversations") throw new Error("boom")
      return defaultHandler(table)
    }
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const log2 = sweep.stores.find((s) => s.store === "conversation_log")!
    expect(log2.searched).toBe(false)
    expect(log2.error).toContain("boom")
  })

  it("truncates long text and drops rows with no text", async () => {
    handler = (table) =>
      table === "portal_messages"
        ? { data: [{ id: "long", created_at: "2026-04-03T00:00:00Z", sender_type: "client", message: "x".repeat(2000) }, { id: "empty", created_at: "2026-04-03T00:00:00Z", sender_type: "client", message: "" }], error: null }
        : defaultHandler(table)
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const portal = sweep.stores.find((s) => s.store === "portal_chat")!
    expect(portal.hits.map((h) => h.id)).toEqual(["long"])
    expect(portal.hits[0].text.length).toBeLessThanOrEqual(240)
  })
})

describe("summarizeChatSweep", () => {
  it("keeps counts and reasons, never the text", async () => {
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    const summary = summarizeChatSweep(sweep)
    expect(summary).toHaveLength(CHAT_STORES.length)
    expect(summary.find((s) => s.store === "portal_chat")).toMatchObject({ label: "portal chats", searched: true, count: 1, error: null })
    expect(JSON.stringify(summary)).not.toContain("no invoices due")
  })
})

describe("the addresses the processor recorded (a card payment's billing email)", () => {
  it("are searched in the chats, after the memo's own address and before the invoice numbers", () => {
    const terms = chatSearchTerms({ sender_name: "EXODUS DIGITAL GROUP LIMITED", memo: "email: a@memo.com - INV 2026 001", emails: ["billing@agency.example"] })
    expect(terms).toEqual(["EXODUS DIGITAL GROUP LIMITED", "a@memo.com", "billing@agency.example", "INV-2026-001", "INV 2026 001"])
  })

  it("never push the list past six, and never repeat an address", () => {
    const terms = chatSearchTerms({ sender_name: "Some Real Company LLC", memo: "email: a@memo.com", emails: ["A@memo.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"] })
    expect(terms.length).toBeLessThanOrEqual(6)
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length)
  })

  it("are looked up in the CRM: a contact with that address becomes a client whose chats are read", async () => {
    handler = (table, calls) => {
      if (table === "contacts" && calls.some((c) => c.method === "ilike" && c.args[0] === "email" && c.args[1] === "billing@agency.example")) {
        return { data: [{ id: "c-billing", full_name: "Billing Owner" }], error: null }
      }
      return defaultHandler(table)
    }
    const sweep = await runChatSweep({ facts: { transaction_date: "2026-02-13", sender_name: "EXODUS DIGITAL GROUP LIMITED", memo: null, emails: ["billing@agency.example"] }, userId: USER_ID, db: fakeDb })
    expect(sweep.clients).toContainEqual({ kind: "contact", id: "c-billing", name: "Billing Owner" })
    expect(callsOf("portal_messages").some((e) => hasCall(e, "in", "contact_id", ["c-billing"]))).toBe(true)
  })

  it("leave the old behaviour alone when there are none", async () => {
    const sweep = await runChatSweep({ facts: FACTS, userId: USER_ID, db: fakeDb })
    expect(callsOf("contacts").every((e) => !e.calls.some((c) => c.method === "ilike" && c.args[0] === "email"))).toBe(true)
    expect(sweep.clients).toEqual([{ kind: "account", id: ACCOUNT_ID, name: "Active Acres Properties LLC" }])
  })
})
