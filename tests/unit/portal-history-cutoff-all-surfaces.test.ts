import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import {
  isItemHiddenByCutoff, filterByHistoryCutoff, historyKeepClauses, accountScopeWithHistory, isSettledPaymentStatus, isHiddenByHistoryCutoff,
} from "@/lib/documents/history-cutoff"
import {
  getHistoryCutoffs, getOpenedItemIds, getHistoryView, setItemOpenToNewOwners, isItemHiddenFromViewer, filterCorrespondenceForViewer,
  isHistoryItemKind, type CutoffDb,
} from "@/lib/portal/history-cutoff"

const CUT = "2026-10-20T00:00:00.000Z"
const OLD = "2026-10-14T10:00:00.000Z"
const NEW = "2026-10-21T10:00:00.000Z"

describe("isItemHiddenByCutoff — the one rule", () => {
  it("no cutoff hides nothing", () => {
    expect(isItemHiddenByCutoff({ created_at: OLD }, null, "c1")).toBe(false)
    expect(isItemHiddenByCutoff({ created_at: OLD }, undefined, "c1")).toBe(false)
  })
  it("hides older, shows newer, shows exactly on the start moment", () => {
    expect(isItemHiddenByCutoff({ created_at: OLD }, CUT, "c1")).toBe(true)
    expect(isItemHiddenByCutoff({ created_at: NEW }, CUT, "c1")).toBe(false)
    expect(isItemHiddenByCutoff({ created_at: CUT }, CUT, "c1")).toBe(false)
  })
  it("staff-opened, own and addressed-to-me items stay visible", () => {
    expect(isItemHiddenByCutoff({ created_at: OLD, opened: true }, CUT, "c1")).toBe(false)
    expect(isItemHiddenByCutoff({ created_at: OLD, ownerContactId: "c1" }, CUT, "c1")).toBe(false)
    expect(isItemHiddenByCutoff({ created_at: OLD, addressedToContactId: "c1" }, CUT, "c1")).toBe(false)
  })
  it("someone else's item is still hidden", () => {
    expect(isItemHiddenByCutoff({ created_at: OLD, ownerContactId: "c2", addressedToContactId: "c3" }, CUT, "c1")).toBe(true)
  })
  it("a teammate (no contact id) with a cutoff never matches 'own' by accident", () => {
    expect(isItemHiddenByCutoff({ created_at: OLD, ownerContactId: null }, CUT, null)).toBe(true)
  })
  it("a bad date never hides", () => {
    expect(isItemHiddenByCutoff({ created_at: "nope" }, CUT, "c1")).toBe(false)
    expect(isItemHiddenByCutoff({ created_at: OLD }, "nope", "c1")).toBe(false)
  })
})

describe("documents wrapper still behaves as in slice 3", () => {
  it("own personal doc stays, company doc hides, opened doc stays", () => {
    expect(isHiddenByHistoryCutoff({ created_at: OLD, category: 2, contact_id: "c1" }, CUT, "c1")).toBe(false)
    expect(isHiddenByHistoryCutoff({ created_at: OLD, category: 2, contact_id: "c2" }, CUT, "c1")).toBe(true)
    expect(isHiddenByHistoryCutoff({ created_at: OLD }, CUT, "c1")).toBe(true)
    expect(isHiddenByHistoryCutoff({ created_at: OLD, visible_to_new_owners: true }, CUT, "c1")).toBe(false)
  })
})

describe("filterByHistoryCutoff", () => {
  const rows = [{ id: "a", at: OLD }, { id: "b", at: NEW }, { id: "c", at: OLD }]
  it("returns the same rows when there is no cutoff", () => {
    expect(filterByHistoryCutoff(rows, null, "c1", r => ({ created_at: r.at }))).toEqual(rows)
  })
  it("drops older rows except opened ones", () => {
    const out = filterByHistoryCutoff(rows, CUT, "c1", r => ({ created_at: r.at, opened: r.id === "c" }))
    expect(out.map(r => r.id)).toEqual(["b", "c"])
  })
})

describe("historyKeepClauses / accountScopeWithHistory", () => {
  it("null without a cutoff or with a bad one", () => {
    expect(historyKeepClauses(null)).toBeNull()
    expect(historyKeepClauses("nope")).toBeNull()
  })
  it("builds the keep list: new, mine, addressed to me, opened", () => {
    expect(historyKeepClauses(CUT, { viewerContactId: "c1", ownerColumns: ["contact_id", "addressed_to_contact_id"], openedIds: ["x", "y"] }))
      .toBe(`created_at.gte.${CUT},contact_id.eq.c1,addressed_to_contact_id.eq.c1,id.in.(x,y)`)
  })
  it("no viewer → no 'mine' clauses; no opened → no id clause", () => {
    expect(historyKeepClauses(CUT, { ownerColumns: ["contact_id"] })).toBe(`created_at.gte.${CUT}`)
  })
  it("scope: whole company without a keep list, narrowed with one", () => {
    expect(accountScopeWithHistory("A", null)).toBe("account_id.eq.A")
    expect(accountScopeWithHistory("A", "created_at.gte.X,contact_id.eq.c1")).toBe("and(account_id.eq.A,or(created_at.gte.X,contact_id.eq.c1))")
  })
})

describe("isSettledPaymentStatus", () => {
  it("only settled statuses follow the start date; what is owed does not", () => {
    for (const s of ["Paid", "Cancelled", "Waived"]) expect(isSettledPaymentStatus(s)).toBe(true)
    for (const s of ["Pending", "Overdue", "Sent", "Partial", "Not Invoiced", null, undefined]) expect(isSettledPaymentStatus(s as string | null | undefined)).toBe(false)
  })
})

describe("isHistoryItemKind", () => {
  it("accepts the known kinds only", () => {
    expect(isHistoryItemKind("invoice")).toBe(true)
    expect(isHistoryItemKind("message")).toBe(true)
    expect(isHistoryItemKind("document")).toBe(false)
    expect(isHistoryItemKind(42)).toBe(false)
  })
})

/** Chainable fake: every builder method returns the same thenable that resolves to the table's preset result. */
function fakeDb(tables: Record<string, { data?: unknown; error?: { message: string } | null } | "throw">) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = []
  const db = {
    from(table: string) {
      const preset = tables[table]
      if (preset === "throw") throw new Error("boom")
      const result = { data: preset?.data ?? null, error: preset?.error ?? null }
      const chain: Record<string, unknown> = {}
      for (const op of ["select", "eq", "not", "upsert", "delete", "update", "is", "maybeSingle"]) {
        chain[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return chain }
      }
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
      return chain
    },
  } as unknown as CutoffDb
  return { db, calls }
}

describe("getHistoryCutoffs", () => {
  it("maps each company to its date; empty for no contact or a failed read", async () => {
    const m = await getHistoryCutoffs("c1", fakeDb({ account_contacts: { data: [{ account_id: "A", history_visible_from: CUT }, { account_id: "B", history_visible_from: null }] } }).db)
    expect(Array.from(m.entries())).toEqual([["A", CUT]])
    expect((await getHistoryCutoffs(null, fakeDb({}).db)).size).toBe(0)
    expect((await getHistoryCutoffs("c1", fakeDb({ account_contacts: "throw" }).db)).size).toBe(0)
  })
})

describe("getOpenedItemIds / getHistoryView", () => {
  it("returns the opened ids; empty on failure", async () => {
    const ids = await getOpenedItemIds("A", "invoice", fakeDb({ history_item_overrides: { data: [{ item_id: "i1" }, { item_id: "i2" }] } }).db)
    expect(Array.from(ids)).toEqual(["i1", "i2"])
    expect((await getOpenedItemIds("A", "invoice", fakeDb({ history_item_overrides: "throw" }).db)).size).toBe(0)
  })
  it("no cutoff → no second lookup", async () => {
    const f = fakeDb({ account_contacts: { data: null }, history_item_overrides: { data: [{ item_id: "i1" }] } })
    const v = await getHistoryView("A", "c1", "invoice", f.db)
    expect(v.cutoff).toBeNull()
    expect(v.opened.size).toBe(0)
    expect(f.calls.some(c => c.table === "history_item_overrides")).toBe(false)
  })
  it("with a cutoff → cutoff plus opened ids", async () => {
    const f = fakeDb({ account_contacts: { data: { history_visible_from: CUT } }, history_item_overrides: { data: [{ item_id: "i1" }] } })
    const v = await getHistoryView("A", "c1", "invoice", f.db)
    expect(v.cutoff).toBe(CUT)
    expect(Array.from(v.opened)).toEqual(["i1"])
  })
})

describe("setItemOpenToNewOwners", () => {
  it("open = upsert, close = delete; returns the database error text", async () => {
    const f = fakeDb({ history_item_overrides: {} })
    expect(await setItemOpenToNewOwners({ accountId: "A", kind: "invoice", itemId: "i1", open: true, by: "luca" }, f.db)).toBeNull()
    expect(f.calls.find(c => c.op === "upsert")?.args[0]).toMatchObject({ item_kind: "invoice", item_id: "i1", account_id: "A", opened_by: "luca" })
    const g = fakeDb({ history_item_overrides: {} })
    expect(await setItemOpenToNewOwners({ accountId: "A", kind: "invoice", itemId: "i1", open: false }, g.db)).toBeNull()
    expect(g.calls.some(c => c.op === "delete")).toBe(true)
    expect(await setItemOpenToNewOwners({ accountId: "A", kind: "invoice", itemId: "i1", open: true }, fakeDb({ history_item_overrides: { error: { message: "bad" } } }).db)).toBe("bad")
  })
})

describe("isItemHiddenFromViewer", () => {
  it("false for staff / teammate / no company", async () => {
    expect(await isItemHiddenFromViewer({ accountId: "A", contactId: null, kind: "invoice", itemId: "i", item: { created_at: OLD } }, fakeDb({}).db)).toBe(false)
    expect(await isItemHiddenFromViewer({ accountId: null, contactId: "c1", kind: "invoice", itemId: "i", item: { created_at: OLD } }, fakeDb({}).db)).toBe(false)
  })
  it("true for an older item, false for newer or opened", async () => {
    const t = { account_contacts: { data: { history_visible_from: CUT } }, history_item_overrides: { data: [{ item_id: "open" }] } }
    expect(await isItemHiddenFromViewer({ accountId: "A", contactId: "c1", kind: "invoice", itemId: "i", item: { created_at: OLD } }, fakeDb(t).db)).toBe(true)
    expect(await isItemHiddenFromViewer({ accountId: "A", contactId: "c1", kind: "invoice", itemId: "i", item: { created_at: NEW } }, fakeDb(t).db)).toBe(false)
    expect(await isItemHiddenFromViewer({ accountId: "A", contactId: "c1", kind: "invoice", itemId: "open", item: { created_at: OLD } }, fakeDb(t).db)).toBe(false)
  })
})

describe("filterCorrespondenceForViewer", () => {
  const rows = [
    { id: "1", account_id: "A", created_at: OLD, contact_id: null },
    { id: "2", account_id: "A", created_at: NEW, contact_id: null },
    { id: "3", account_id: "A", created_at: OLD, contact_id: "c1" },
    { id: "4", account_id: "B", created_at: OLD, contact_id: null },
    { id: "5", account_id: null, created_at: OLD, contact_id: "c1" },
  ]
  it("everyone without a start date sees every row", async () => {
    const out = await filterCorrespondenceForViewer(rows, "c1", fakeDb({ account_contacts: { data: [] } }).db)
    expect(out).toHaveLength(5)
  })
  it("cuts only the company with a start date; own mail and other companies stay", async () => {
    const out = await filterCorrespondenceForViewer(rows, "c1", fakeDb({ account_contacts: { data: [{ account_id: "A", history_visible_from: CUT }] }, history_item_overrides: { data: [] } }).db)
    expect(out.map(r => r.id)).toEqual(["2", "3", "4", "5"])
  })
  it("a letter staff opened stays", async () => {
    const out = await filterCorrespondenceForViewer(rows, "c1", fakeDb({ account_contacts: { data: [{ account_id: "A", history_visible_from: CUT }] }, history_item_overrides: { data: [{ item_id: "1" }] } }).db)
    expect(out.map(r => r.id)).toEqual(["1", "2", "3", "4", "5"])
  })
})
