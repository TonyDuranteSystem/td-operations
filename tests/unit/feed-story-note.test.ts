/**
 * Writing a payment's investigation onto an invoice note. What must hold: only a sure-enough result is
 * written; only on an invoice the story is about; never twice; never over a note someone else just changed.
 * Remove the verdict gate and the "unclear" test fails; remove the about-this-invoice check and the
 * wrong-invoice test fails; drop the compare-and-swap and the concurrent-edit test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Call = { table: string; method: string; args: unknown[] }
let calls: Call[] = []
let feedRow: Record<string, unknown> | null
let invoiceRows: Array<Record<string, unknown>>
let invoiceReadError: { message: string } | null
/** What each read of one invoice's note returns, in order; the last value repeats. */
let noteReads: Array<string | null>
let updateResults: Array<{ data: Array<{ id: string }> | null; error: { message: string } | null }>

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const mine: Call[] = []
      let selected = ""
      let isUpdate = false
      const q: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          const name = String(prop)
          if (name === "then") {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
              // list read: payments in (...)
              return Promise.resolve({ data: invoiceReadError ? null : invoiceRows, error: invoiceReadError }).then(res, rej)
            }
          }
          if (name === "maybeSingle") {
            return () => {
              if (table === "td_bank_feeds") return Promise.resolve({ data: feedRow, error: null })
              const note = noteReads.length > 1 ? noteReads.shift()! : noteReads[0]
              return Promise.resolve({ data: { notes: note }, error: null })
            }
          }
          return (...args: unknown[]) => {
            mine.push({ table, method: name, args })
            calls.push({ table, method: name, args })
            if (name === "update") isUpdate = true
            if (name === "select") selected = String(args[0])
            if (name === "select" && isUpdate) {
              return Promise.resolve(updateResults.length > 1 ? updateResults.shift()! : updateResults[0])
            }
            void selected
            return q
          }
        },
      })
      return q
    },
  },
}))

import { writeFeedStoryToInvoices, storyIsAboutInvoice, describeStoryResult, appendStoryToInvoiceNote } from "@/lib/operations/feed-story-note"
import { storyMarker } from "@/lib/finance/feed-investigation"

const FEED_ID = "228b5a19-9a35-4221-84bc-1226d4a605c0"
const INV_A = "6988a759-5b7a-4e56-8e68-441142a483a3"
const INV_B = "7a5f7ec8-4926-4b6f-889e-8e9debe62104"
const CONTACT = "11ba2e7c-36fe-48bd-986e-13b0d6f24a24"

const investigation = (over: Record<string, unknown> = {}) => ({
  verdict: "likely", who: { name: "Simone Fattor", contact_id: CONTACT, account_id: null, lead_id: null }, summary: "An apostille customer.",
  story: "He asked for an apostille; we did it; he paid €500.", sources: [{ kind: "email", label: "Airwallex notice", date: "2026-05-29", mailbox: "support@tonydurante.us", id: "m1", verified: true }],
  suggested_invoice_ids: [], suggested_next: "create_invoice", at: "2026-10-30T12:00:00.000Z", by: "u1", tools_used: [], mailboxes_searched: [], mailboxes_failed: [], ...over,
})

beforeEach(() => {
  calls = []
  feedRow = { id: FEED_ID, source: "airwallex_api", transaction_date: "2026-05-29", amount: 500, currency: "EUR", sender_name: "Simone Fattor", review_metadata: { investigation: investigation() } }
  invoiceRows = [{ id: INV_A, account_id: null, contact_id: CONTACT }, { id: INV_B, account_id: "acct-other", contact_id: null }]
  invoiceReadError = null
  noteReads = [null]
  updateResults = [{ data: [{ id: INV_A }], error: null }]
})

describe("storyIsAboutInvoice", () => {
  const story = { who: { name: "x", contact_id: CONTACT, account_id: "acct-1", lead_id: null }, suggested_invoice_ids: [INV_B] }
  it("is about an invoice the AI suggested, one of the person/company it named, or one this flow just created", () => {
    expect(storyIsAboutInvoice(story, { id: INV_B, account_id: null, contact_id: null }, false)).toBe(true)
    expect(storyIsAboutInvoice(story, { id: "z", account_id: null, contact_id: CONTACT }, false)).toBe(true)
    expect(storyIsAboutInvoice(story, { id: "z", account_id: "acct-1", contact_id: null }, false)).toBe(true)
    expect(storyIsAboutInvoice({ who: null, suggested_invoice_ids: [] }, { id: "z", account_id: null, contact_id: null }, true)).toBe(true)
  })
  it("is NOT about an unrelated invoice", () => {
    expect(storyIsAboutInvoice(story, { id: "z", account_id: "acct-9", contact_id: "c-9" }, false)).toBe(false)
    expect(storyIsAboutInvoice({ who: null, suggested_invoice_ids: [] }, { id: "z", account_id: null, contact_id: null }, false)).toBe(false)
  })
})

describe("writeFeedStoryToInvoices", () => {
  it("writes the labelled story onto an invoice of the person it names, with the marker", async () => {
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r).toMatchObject({ hadStory: true, written: [INV_A], failed: [], skipped: [] })
    const update = calls.find((c) => c.method === "update")!
    const notes = (update.args[0] as { notes: string }).notes
    expect(notes).toContain(storyMarker(FEED_ID))
    expect(notes).toMatch(/AI-written, UNVERIFIED/)
    expect(notes).toContain("apostille")
  })

  it("a failed read of the invoices is reported as a FAILURE, not as 'Invoice not found'", async () => {
    invoiceReadError = { message: "connection reset" }
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r.written).toEqual([])
    expect(r.skipped).toEqual([])
    expect(r.failed[0].error).toMatch(/could not read the invoices: connection reset/)
    expect(describeStoryResult(r)).toMatch(/could NOT be saved/)
  })

  it("a malformed invoice id is skipped on its own and does not spoil the valid one next to it", async () => {
    const r = await writeFeedStoryToInvoices(FEED_ID, ["not-a-uuid", INV_A])
    expect(r.skipped).toEqual([{ paymentId: "not-a-uuid", reason: "Not a valid invoice id." }])
    expect(r.written).toEqual([INV_A])
    const read = calls.find((c) => c.table === "payments" && c.method === "in")!
    expect(read.args[1]).toEqual([INV_A])
  })

  it("writes NOTHING for an 'unclear' result, and does not even touch the invoice", async () => {
    feedRow = { ...feedRow!, review_metadata: { investigation: investigation({ verdict: "unclear" }) } }
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r.written).toEqual([])
    expect(r.skipped[0].reason).toMatch(/not sure enough/)
    expect(calls.some((c) => c.method === "update")).toBe(false)
  })

  it("does nothing when the payment has no investigation", async () => {
    feedRow = { ...feedRow!, review_metadata: {} }
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r.hadStory).toBe(false)
    expect(calls.some((c) => c.method === "update")).toBe(false)
    expect(describeStoryResult(r)).toBeNull()
  })

  it("does NOT copy the story onto an invoice it is not about", async () => {
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_B])
    expect(r.written).toEqual([])
    expect(r.skipped[0]).toMatchObject({ paymentId: INV_B, reason: expect.stringMatching(/different invoice or client/) })
    expect(calls.some((c) => c.method === "update")).toBe(false)
  })

  it("writes on an invoice this flow just created, even though the person was not known before", async () => {
    feedRow = { ...feedRow!, review_metadata: { investigation: investigation({ who: null }) } }
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_B], [INV_B])
    expect(r.written).toEqual([INV_B])
  })

  it("never writes the same payment's story twice", async () => {
    noteReads = [`earlier note\n\n${storyMarker(FEED_ID)} already here`]
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r.alreadyThere).toEqual([INV_A])
    expect(r.written).toEqual([])
    expect(calls.some((c) => c.method === "update")).toBe(false)
  })

  it("is a compare-and-swap: the write is conditional on the note it read", async () => {
    noteReads = ["Client promised to pay in September."]
    await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    const eq = calls.filter((c) => c.method === "eq").map((c) => c.args)
    expect(eq).toContainEqual(["notes", "Client promised to pay in September."])
    const notes = (calls.find((c) => c.method === "update")!.args[0] as { notes: string }).notes
    expect(notes.startsWith("Client promised to pay in September.\n\n")).toBe(true)
  })

  it("uses 'is null' as the condition when the note was empty", async () => {
    await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(calls.some((c) => c.method === "is" && c.args[0] === "notes" && c.args[1] === null)).toBe(true)
  })

  it("when someone edited the note in between, it re-reads and tries again, then succeeds", async () => {
    noteReads = [null, "someone just typed this"]
    updateResults = [{ data: [], error: null }, { data: [{ id: INV_A }], error: null }]
    const r = await appendStoryToInvoiceNote(INV_A, FEED_ID, "BLOCK")
    expect(r).toEqual({ ok: true, appended: true })
    const updates = calls.filter((c) => c.method === "update")
    expect(updates).toHaveLength(2)
    expect((updates[1].args[0] as { notes: string }).notes).toBe(`someone just typed this\n\nBLOCK`)
  })

  it("gives up plainly (and writes nothing) if the note keeps changing", async () => {
    noteReads = [null, "a", "b"]
    updateResults = [{ data: [], error: null }]
    const r = await appendStoryToInvoiceNote(INV_A, FEED_ID, "BLOCK")
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/edited while saving/) })
  })

  it("reports a database error as a failure for that invoice, never as success", async () => {
    updateResults = [{ data: null, error: { message: "boom" } }]
    const r = await writeFeedStoryToInvoices(FEED_ID, [INV_A])
    expect(r.failed).toEqual([{ paymentId: INV_A, error: "boom" }])
    expect(describeStoryResult(r)).toMatch(/could NOT be saved/)
  })
})

describe("describeStoryResult", () => {
  it("says what happened in one plain sentence", () => {
    expect(describeStoryResult({ hadStory: true, written: [INV_A], alreadyThere: [], skipped: [], failed: [] })).toMatch(/saved on the invoice's note/)
    expect(describeStoryResult({ hadStory: true, written: [INV_A, INV_B], alreadyThere: [], skipped: [], failed: [] })).toMatch(/2 invoice notes/)
    expect(describeStoryResult({ hadStory: true, written: [], alreadyThere: [], skipped: [{ paymentId: INV_B, reason: "Different client." }], failed: [] })).toBe("Different client.")
  })
})
