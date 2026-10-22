import { describe, it, expect } from "vitest"
import { PAGE, readPaged } from "@/lib/marketing/paged"
import { buildSetterNote, personName, pickLatestNotes } from "@/lib/marketing/setter-note"
import type { LeadEventRow } from "@/lib/marketing/leads-read"

const ev = (id: number, kind: string, actor: string, data: Record<string, unknown>, at: string): LeadEventRow => ({ id, kind, actor, data, created_at: at })
const reasons = [{ key: "wrong_profile", label: "Wrong profile" }]

describe("personName", () => {
  it("makes a readable name from an email, and never invents one", () => {
    expect(personName("chiara.neri@tonydurante.us")).toBe("Chiara Neri")
    expect(personName("rocco_resta@x.com")).toBe("Rocco Resta")
    expect(personName("qa-ws-settera@example.test")).toBe("Qa Ws Settera")
    expect(personName("12345@x.com")).toBe("12345@x.com")
    expect(personName("")).toBe("Someone")
    expect(personName(null)).toBe("Someone")
  })
})

describe("buildSetterNote", () => {
  it("takes the NEWEST outcome with its note, whatever order the history comes in; other notes newest first, at most 3", () => {
    const events = [
      ev(1, "status_changed", "a.b@x", { outcome: "good", note: "first" }, "2026-10-20T09:00:00Z"),
      ev(2, "status_changed", "c.d@x", { outcome: "not_in_target", reason: "wrong_profile", note: "changed my mind" }, "2026-10-21T09:00:00Z"),
      ev(3, "note", "r.r@x", { text: "n1" }, "2026-10-21T10:00:00Z"), ev(4, "note", "r.r@x", { text: "n2" }, "2026-10-21T11:00:00Z"),
      ev(5, "note", "r.r@x", { text: "n3" }, "2026-10-21T12:00:00Z"), ev(6, "note", "r.r@x", { text: "n4" }, "2026-10-21T13:00:00Z"),
    ]
    const n = buildSetterNote([...events].reverse(), reasons)
    expect(n.outcome).toMatchObject({ outcome: "not_in_target", by: "C D", reasonLabel: "Wrong profile", note: "changed my mind" })
    expect(n.notes.map(x => x.text)).toEqual(["n4", "n3", "n2"])
  })
  it("a call back carries its time; a Good without a note has an empty note; no outcome and no notes = nothing", () => {
    expect(buildSetterNote([ev(1, "status_changed", "a@x", { outcome: "call_back", callback_at: "2026-10-22T14:00:00Z" }, "2026-10-21T09:00:00Z")], reasons).outcome).toMatchObject({ outcome: "call_back", callbackAt: "2026-10-22T14:00:00Z", note: "" })
    expect(buildSetterNote([ev(1, "status_changed", "a@x", { outcome: "good" }, "2026-10-21T09:00:00Z")], reasons).outcome?.note).toBe("")
    expect(buildSetterNote([ev(1, "received", "system", {}, "2026-10-21T09:00:00Z"), ev(2, "claimed", "a@x", {}, "2026-10-21T09:05:00Z")], reasons)).toEqual({ outcome: null, notes: [] })
  })
  it("an unknown reason key is shown as itself; a status change that is not an outcome is ignored", () => {
    expect(buildSetterNote([ev(1, "status_changed", "a@x", { outcome: "not_in_target", reason: "gone" }, "2026-10-21T09:00:00Z")], reasons).outcome?.reasonLabel).toBe("gone")
    expect(buildSetterNote([ev(1, "status_changed", "a@x", { from: "new", to: "qualified" }, "2026-10-21T09:00:00Z")], reasons).outcome).toBeNull()
  })
})

describe("pickLatestNotes (the note shown on each Good lead's row)", () => {
  it("per lead: the newest written note, from an outcome or a note row; leads with nothing written are left out", () => {
    const m = pickLatestNotes([
      { lead_id: "l1", kind: "status_changed", actor: "a.b@x", data: { outcome: "good", note: "old" }, created_at: "2026-10-20T09:00:00Z" },
      { lead_id: "l1", kind: "note", actor: "r.r@x", data: { text: "newer" }, created_at: "2026-10-21T09:00:00Z" },
      { lead_id: "l2", kind: "status_changed", actor: "a.b@x", data: { outcome: "good" }, created_at: "2026-10-20T09:00:00Z" },
      { lead_id: "l3", kind: "claimed", actor: "a.b@x", data: {}, created_at: "2026-10-20T09:00:00Z" },
    ])
    expect(m.get("l1")).toEqual({ text: "newer", by: "R R", at: "2026-10-21T09:00:00Z" })
    expect(m.has("l2")).toBe(false)
    expect(m.has("l3")).toBe(false)
  })
})

describe("readPaged (the database cuts one answer at 1000 rows, so long lists are read in pages)", () => {
  const source = (total: number) => { const all = Array.from({ length: total }, (_, i) => i); const calls: Array<[number, number]> = []; return { calls, page: async (from: number, to: number) => { calls.push([from, to]); return { data: all.slice(from, Math.min(to, from + PAGE - 1) + 1) } } } }
  it("reads past 1000 rows: 2500 rows come back whole, in three pages", async () => {
    const s = source(2500)
    const r = await readPaged(s.page, 20000)
    expect(r.rows.length).toBe(2500)
    expect(r.truncated).toBe(false)
    expect(s.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it("a list shorter than one page costs one read; an exact multiple costs one extra empty read", async () => {
    expect((await readPaged(source(10).page, 20000)).rows.length).toBe(10)
    const s = source(2000)
    expect((await readPaged(s.page, 20000)).rows.length).toBe(2000)
    expect(s.calls.length).toBe(3)
  })
  it("at the cap: the first rows and truncated = true; exactly the cap is NOT truncated", async () => {
    const over = await readPaged(source(5200).page, 5000)
    expect(over.rows.length).toBe(5000)
    expect(over.truncated).toBe(true)
    const exact = await readPaged(source(5000).page, 5000)
    expect(exact.rows.length).toBe(5000)
    expect(exact.truncated).toBe(false)
  })
  it("nothing in the database is an empty list, not an error", async () => {
    expect(await readPaged(async () => ({ data: null }), 100)).toEqual({ rows: [], truncated: false })
  })
})

describe("the latest-note rule is the same on Today and on the lead", () => {
  const e = (lead_id: string, kind: string, data: Record<string, unknown>, at: string, actor = "a.b@x") => ({ lead_id, kind, actor, data, created_at: at })
  it("a newer outcome WITHOUT a note hides an older outcome's note (the older one is out of date)", () => {
    const m = pickLatestNotes([e("l1", "status_changed", { outcome: "good", note: "old" }, "2026-10-20T09:00:00Z"), e("l1", "status_changed", { outcome: "call_back" }, "2026-10-21T09:00:00Z")])
    expect(m.has("l1")).toBe(false)
  })
  it("a standalone note after it still shows", () => {
    const m = pickLatestNotes([e("l1", "status_changed", { outcome: "good", note: "old" }, "2026-10-20T09:00:00Z"), e("l1", "status_changed", { outcome: "call_back" }, "2026-10-21T09:00:00Z"), e("l1", "note", { text: "fresh" }, "2026-10-21T10:00:00Z")])
    expect(m.get("l1")?.text).toBe("fresh")
  })
  it("Antonio's View as rows are never the team's note on Today", () => {
    const m = pickLatestNotes([e("l1", "status_changed", { outcome: "good", note: "real" }, "2026-10-20T09:00:00Z"), e("l1", "note", { text: "just testing", via_view_as: true }, "2026-10-21T10:00:00Z", "antonio@x")])
    expect(m.get("l1")?.text).toBe("real")
  })
  it("on the lead his rows are shown but marked", () => {
    const n = buildSetterNote([ev(1, "status_changed", "antonio@x", { outcome: "good", note: "test", via_view_as: true }, "2026-10-21T09:00:00Z"), ev(2, "note", "antonio@x", { text: "t2", via_view_as: true }, "2026-10-21T10:00:00Z")], reasons)
    expect(n.outcome?.viaViewAs).toBe(true)
    expect(n.notes[0].viaViewAs).toBe(true)
  })
})

describe("personName edge cases", () => {
  it("does not break a first character that is outside the basic range", () => {
    expect(personName("😀.smith@x.com")).toBe("😀 Smith")
  })
})
