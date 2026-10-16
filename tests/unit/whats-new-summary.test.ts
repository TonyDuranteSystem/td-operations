import { describe, it, expect } from "vitest"
import { groupWhatsNewSummary, MAX_CLIENTS, TEXT_LENGTH, type SummaryNote } from "@/lib/notifications/whats-new-summary"

/**
 * What's New summary (the New Calendar's What's New tab): which clients have something new, newest first.
 * The total must equal the purple dot's total: every unhandled visible note that belongs to a company or a person, counted once.
 */

const names = (accounts: Record<string, string | null> = {}, contacts: Record<string, string | null> = {}) => ({
  accounts: new Map(Object.entries(accounts)),
  contacts: new Map(Object.entries(contacts)),
})

let n = 0
const note = (over: Partial<SummaryNote>): SummaryNote => ({
  account_id: "a1",
  contact_id: null,
  created_at: `2026-10-${String(10 + (n++ % 9)).padStart(2, "0")}T12:00:00Z`,
  text: "Client paid an invoice",
  event_key: "payment_received",
  ...over,
})

describe("groupWhatsNewSummary", () => {
  it("counts each note once and groups by company, newest client first", () => {
    const s = groupWhatsNewSummary(
      [
        note({ account_id: "a1", created_at: "2026-10-10T10:00:00Z" }),
        note({ account_id: "a1", created_at: "2026-10-12T10:00:00Z", text: "Latest for Acme", event_key: "ss4_signed" }),
        note({ account_id: "a2", created_at: "2026-10-14T10:00:00Z", text: "Newest of all" }),
      ],
      names({ a1: "Acme LLC", a2: "Beta LLC" }),
    )
    expect(s.total).toBe(3)
    expect(s.clientCount).toBe(2)
    expect(s.clients.map(c => c.name)).toEqual(["Beta LLC", "Acme LLC"])
    const acme = s.clients[1]
    expect(acme.count).toBe(2)
    expect(acme.latestText).toBe("Latest for Acme")
    expect(acme.latestEventKey).toBe("ss4_signed")
    expect(acme.accountId).toBe("a1")
    expect(acme.contactId).toBeNull()
  })

  it("a note with a company and a person belongs to the company; a person-only note belongs to the person", () => {
    const s = groupWhatsNewSummary(
      [note({ account_id: "a1", contact_id: "c1" }), note({ account_id: null, contact_id: "c2", created_at: "2026-10-20T00:00:00Z" })],
      names({ a1: "Acme LLC" }, { c2: "Maria Rossi" }),
    )
    expect(s.total).toBe(2)
    expect(s.clients.map(c => c.key).sort()).toEqual(["account:a1", "contact:c2"])
    expect(s.clients.find(c => c.key === "contact:c2")).toMatchObject({ name: "Maria Rossi", accountId: null, contactId: "c2" })
  })

  it("a note with neither company nor person is not counted (the dot does not count it either)", () => {
    const s = groupWhatsNewSummary([note({ account_id: null, contact_id: null })], names())
    expect(s.total).toBe(0)
    expect(s.clients).toEqual([])
  })

  it("a missing name says so instead of showing an id", () => {
    const s = groupWhatsNewSummary([note({ account_id: "a9" }), note({ account_id: null, contact_id: "c9" })], names({ a9: "  " }))
    expect(s.clients.map(c => c.name).sort()).toEqual(["Unnamed company", "Unnamed person"])
  })

  it("keeps the text on one line and cuts it", () => {
    const s = groupWhatsNewSummary([note({ text: `line one\n\n   line   two ${"x".repeat(400)}` })], names({ a1: "Acme" }))
    expect(s.clients[0].latestText.startsWith("line one line two ")).toBe(true)
    expect(s.clients[0].latestText.length).toBe(TEXT_LENGTH)
  })

  it("cuts the list to the cap but still counts every note, and says it was cut", () => {
    const many = Array.from({ length: MAX_CLIENTS + 5 }, (_, i) => note({ account_id: `acct-${i}`, created_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }))
    const s = groupWhatsNewSummary(many, names())
    expect(s.total).toBe(MAX_CLIENTS + 5)
    expect(s.clientCount).toBe(MAX_CLIENTS + 5)
    expect(s.clients).toHaveLength(MAX_CLIENTS)
    expect(s.truncated).toBe(true)
  })

  it("flags a read that hit its row ceiling, even when the list is short", () => {
    expect(groupWhatsNewSummary([note({})], names({ a1: "Acme" }), { readTruncated: true }).truncated).toBe(true)
    expect(groupWhatsNewSummary([note({})], names({ a1: "Acme" })).truncated).toBe(false)
  })

  it("an empty read is an honest zero", () => {
    expect(groupWhatsNewSummary([], names())).toEqual({ total: 0, clientCount: 0, clients: [], truncated: false })
  })

  it("two clients with the same newest time keep a stable order", () => {
    const t = "2026-10-15T00:00:00Z"
    const a = groupWhatsNewSummary([note({ account_id: "b", created_at: t }), note({ account_id: "a", created_at: t })], names())
    const b = groupWhatsNewSummary([note({ account_id: "a", created_at: t }), note({ account_id: "b", created_at: t })], names())
    expect(a.clients.map(c => c.key)).toEqual(b.clients.map(c => c.key))
  })

  it("cuts a long note without splitting an emoji in half", () => {
    const text = "😀".repeat(TEXT_LENGTH + 5)
    const s = groupWhatsNewSummary([note({ text })], names({ a1: "Acme LLC" }))
    const out = s.clients[0].latestText
    expect(Array.from(out).length).toBe(TEXT_LENGTH)
    expect(out).toBe("😀".repeat(TEXT_LENGTH))
  })
})
