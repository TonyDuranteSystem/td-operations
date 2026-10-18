import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { isHiddenByHistoryCutoff, normalizeHistoryChoice } from "@/lib/documents/history-cutoff"
import { getHistoryCutoff, historyFromForNewLink, startHistoryFromNow, type CutoffDb } from "@/lib/portal/history-cutoff"

const CUT = "2026-10-20T00:00:00.000Z"
const old = { created_at: "2026-10-14T10:00:00.000Z" }
const fresh = { created_at: "2026-10-21T10:00:00.000Z" }

describe("isHiddenByHistoryCutoff", () => {
  it("no cutoff = nothing hidden (every existing person)", () => {
    expect(isHiddenByHistoryCutoff(old, null, "c1")).toBe(false)
    expect(isHiddenByHistoryCutoff(old, undefined, "c1")).toBe(false)
  })
  it("hides what was saved before the start date, shows what came after", () => {
    expect(isHiddenByHistoryCutoff(old, CUT, "c1")).toBe(true)
    expect(isHiddenByHistoryCutoff(fresh, CUT, "c1")).toBe(false)
  })
  it("a document staff opened on purpose is always visible", () => {
    expect(isHiddenByHistoryCutoff({ ...old, visible_to_new_owners: true }, CUT, "c1")).toBe(false)
  })
  it("the person's OWN personal document is never company history", () => {
    expect(isHiddenByHistoryCutoff({ ...old, category: 2, contact_id: "c1" }, CUT, "c1")).toBe(false)
    expect(isHiddenByHistoryCutoff({ ...old, category: 2, contact_id: "c2" }, CUT, "c1")).toBe(true)
  })
  it("a bad date never hides anything", () => {
    expect(isHiddenByHistoryCutoff({ created_at: "nonsense" }, CUT, "c1")).toBe(false)
    expect(isHiddenByHistoryCutoff(old, "nonsense", "c1")).toBe(false)
  })
})

describe("normalizeHistoryChoice", () => {
  it("only an explicit 'all' shows everything; anything else is 'today'", () => {
    expect(normalizeHistoryChoice("all")).toBe("all")
    expect(normalizeHistoryChoice("today")).toBe("today")
    expect(normalizeHistoryChoice(undefined)).toBe("today")
    expect(normalizeHistoryChoice(true)).toBe("today")
  })
})

/** Tiny fake of account_contacts + documents. */
function fakeDb(o: { link?: unknown; from?: string | null; docCount?: number; throwOn?: string; updateError?: boolean }) {
  const updates: Array<Record<string, unknown>> = []
  const db = {
    from(table: string) {
      if (o.throwOn === table) throw new Error("boom")
      if (table === "documents") {
        return { select: () => ({ eq: () => ({ eq: async () => ({ count: o.docCount ?? 0 }) }) }) }
      }
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: o.link ?? (o.from !== undefined ? { history_visible_from: o.from } : null) }) }) }) }),
        update: (v: Record<string, unknown>) => ({ eq: () => ({ eq: async () => { updates.push(v); return { error: o.updateError ? { message: "x" } : null } } }) }),
      }
    },
  } as unknown as CutoffDb
  return { db, updates }
}

describe("getHistoryCutoff", () => {
  it("returns the stored date, or null", async () => {
    expect(await getHistoryCutoff("a", "c", fakeDb({ from: CUT }).db)).toBe(CUT)
    expect(await getHistoryCutoff("a", "c", fakeDb({ from: null }).db)).toBeNull()
    expect(await getHistoryCutoff("a", "c", fakeDb({}).db)).toBeNull()
  })
  it("a teammate (no contact) or a failed read sees everything, never an error", async () => {
    expect(await getHistoryCutoff("a", null, fakeDb({}).db)).toBeNull()
    expect(await getHistoryCutoff("a", "c", fakeDb({ throwOn: "account_contacts" }).db)).toBeNull()
  })
})

describe("historyFromForNewLink", () => {
  const now = new Date("2026-10-20T00:00:00.000Z")
  it("a company with documents and the default choice → from now", async () => {
    expect(await historyFromForNewLink({ accountId: "a", contactId: "c", choice: "today", now }, fakeDb({ docCount: 5 }).db)).toBe(CUT)
  })
  it("the choice 'all' → sees everything (null)", async () => {
    expect(await historyFromForNewLink({ accountId: "a", contactId: "c", choice: "all", now }, fakeDb({ docCount: 5 }).db)).toBeNull()
  })
  it("a company with no client-visible documents has no history to hide → null", async () => {
    expect(await historyFromForNewLink({ accountId: "a", contactId: "c", choice: "today", now }, fakeDb({ docCount: 0 }).db)).toBeNull()
  })
  it("a person who is already linked is left alone (undefined)", async () => {
    expect(await historyFromForNewLink({ accountId: "a", contactId: "c", choice: "today", now }, fakeDb({ link: { account_id: "a" }, docCount: 5 }).db)).toBeUndefined()
  })
  it("a failed read never cuts anyone off (null)", async () => {
    expect(await historyFromForNewLink({ accountId: "a", contactId: "c", choice: "today", now }, fakeDb({ throwOn: "documents" }).db)).toBeNull()
  })
})

describe("startHistoryFromNow", () => {
  it("stamps the date when the company has documents", async () => {
    const f = fakeDb({ docCount: 3 })
    expect(await startHistoryFromNow({ accountId: "a", contactId: "c", now: new Date(CUT) }, f.db)).toBe(true)
    expect(f.updates).toEqual([{ history_visible_from: CUT }])
  })
  it("does nothing for a company without documents, and never throws", async () => {
    const f = fakeDb({ docCount: 0 })
    expect(await startHistoryFromNow({ accountId: "a", contactId: "c" }, f.db)).toBe(false)
    expect(f.updates).toEqual([])
    expect(await startHistoryFromNow({ accountId: "a", contactId: "c" }, fakeDb({ throwOn: "documents" }).db)).toBe(false)
  })
})
