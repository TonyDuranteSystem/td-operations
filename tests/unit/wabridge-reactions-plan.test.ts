import { describe, it, expect } from "vitest"
// @ts-expect-error — plain ESM script shared with the Mac (no type declarations)
import * as P from "../../scripts/wa-bridge/reactions-plan.mjs"

const row = (over: Record<string, unknown> = {}) => ({
  message_id: "3A005FCF60C597CA99D0",
  chat_jid: "17274234285@s.whatsapp.net",
  reactor_jid: "17274234285@s.whatsapp.net",
  emoji: "👍",
  is_from_me: 0,
  reaction_timestamp: "2026-10-07 01:11:03+00:00",
  updated_at: "2026-10-07 01:11:03.910263+00:00",
  ...over,
})
const none = new Set<string>()

describe("currentReactions", () => {
  it("one entry per (message, side); the side comes from is_from_me, never the JID", () => {
    const m = P.currentReactions([row(), row({ is_from_me: 1, emoji: "❤️", reactor_jid: "17274521093@s.whatsapp.net" })])
    expect([...m.keys()].sort()).toEqual(["3A005FCF60C597CA99D0|client", "3A005FCF60C597CA99D0|line"])
    // a hidden-id (@lid) reactor on a normal phone chat is still the client side
    expect(P.currentReactions([row({ reactor_jid: "1234567890123@lid" })]).get("3A005FCF60C597CA99D0|client").emoji).toBe("👍")
  })
  it("keeps 1:1 phone chats only and ignores groups, hidden-id chats, empty emoji and junk rows", () => {
    const m = P.currentReactions([
      row({ chat_jid: "120363402106XXXXX@g.us" }),
      row({ chat_jid: "1234567890123@lid", message_id: "AAAA1111" }),
      row({ emoji: "", message_id: "BBBB2222" }),
      row({ message_id: "" }),
      null, "x", 5,
    ])
    expect(m.size).toBe(0)
  })
  it("the newest write wins when two rows exist for the same side", () => {
    const m = P.currentReactions([row({ emoji: "👍", updated_at: "2026-10-07 01:00:00+00:00" }), row({ emoji: "😂", updated_at: "2026-10-07 02:00:00+00:00" })])
    expect(m.get("3A005FCF60C597CA99D0|client").emoji).toBe("😂")
  })
})

describe("planScan — adds and changes", () => {
  it("the first scan reports every current reaction as a set, with the phone's time for display", () => {
    const plan = P.planScan({ rows: [row()], state: P.emptyState(), existingParentIds: none })
    expect(plan.skip).toBe(false)
    expect(plan.items).toEqual([{ ext_id: "3A005FCF60C597CA99D0", chat: "17274234285", side: "client", op: "set", emoji: "👍", reacted_at: "2026-10-07T01:11:03.000Z" }])
    expect(plan.keys).toEqual(["3A005FCF60C597CA99D0|client"])
  })
  it("an acknowledged reaction is not reported again; a change or a newer time is", () => {
    const acked = { acked: { "3A005FCF60C597CA99D0|client": { emoji: "👍", ts: "2026-10-07 01:11:03+00:00", chat: "17274234285" } }, tries: {}, absent: {} }
    expect(P.planScan({ rows: [row()], state: acked, existingParentIds: none }).items).toEqual([])
    expect(P.planScan({ rows: [row({ emoji: "😂" })], state: acked, existingParentIds: none }).items[0].emoji).toBe("😂")
    expect(P.planScan({ rows: [row({ reaction_timestamp: "2026-10-07 01:11:23+00:00" })], state: acked, existingParentIds: none }).items).toHaveLength(1)
  })
})

describe("planScan — removals", () => {
  const key = "3A005FCF60C597CA99D0|client"
  const withAcked = (absent = 0) => ({ acked: { [key]: { emoji: "👍", ts: "t", chat: "17274234285" } }, tries: {}, absent: absent ? { [key]: absent } : {}, emptyScans: 0 })
  const parents = new Set(["3A005FCF60C597CA99D0"])

  it("a vanished reaction is NOT removed on the first scan (debounce against a half-written read)", () => {
    const plan = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state: withAcked(), existingParentIds: parents })
    expect(plan.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
    expect(plan.nextState.absent[key]).toBe(1)
  })
  it("…but is removed once it has stayed missing for the second scan, with the parent message still present", () => {
    const plan = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state: withAcked(1), existingParentIds: parents })
    expect(plan.items.find((i: { op: string }) => i.op === "remove")).toEqual({ ext_id: "3A005FCF60C597CA99D0", chat: "17274234285", side: "client", op: "remove" })
  })
  it("if the PARENT message is gone it is not a removal — the entry is simply forgotten", () => {
    const plan = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state: withAcked(1), existingParentIds: none })
    expect(plan.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
    expect(plan.nextState.acked[key]).toBeUndefined()
  })
  it("a reaction that comes back resets the missing count", () => {
    const plan = P.planScan({ rows: [row()], state: withAcked(1), existingParentIds: parents })
    expect(plan.nextState.absent[key]).toBeUndefined()
  })
  it("the guard refuses a flood of removals (> 3) and keeps counting; --accept-removals lets a checked batch through", () => {
    const acked: Record<string, unknown> = {}
    const absent: Record<string, number> = {}
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { const id = `MSG${i}AAAA`; ids.push(id); acked[`${id}|client`] = { emoji: "👍", ts: "t", chat: "17274234285" }; absent[`${id}|client`] = 1 }
    const state = { acked, tries: {}, absent }
    const refused = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state, existingParentIds: new Set(ids) })
    expect(refused.guard).toEqual({ tripped: true, removals: 5 })
    expect(refused.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
    const allowed = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state, existingParentIds: new Set(ids), acceptRemovals: true })
    expect(allowed.items.filter((i: { op: string }) => i.op === "remove")).toHaveLength(5)
  })
  it("an EMPTY read while reactions were reported before is distrusted as a failed read, never 'everything was removed' at once", () => {
    const plan = P.planScan({ rows: [], state: withAcked(1), existingParentIds: parents })
    expect(plan.skip).toBe(true)
    expect(plan.items).toEqual([])
    expect(plan.nextState).toEqual({ ...withAcked(1), emptyScans: 1 })
  })
  it("…but only for MAX_EMPTY_SCANS in a row: after that a file that really emptied is believed (and cannot wedge the reader)", () => {
    const state = { ...withAcked(1), emptyScans: P.MAX_EMPTY_SCANS }
    const plan = P.planScan({ rows: [], state, existingParentIds: parents })
    expect(plan.skip).toBe(false)
    expect(plan.items.find((i: { op: string }) => i.op === "remove")).toBeDefined() // parent exists + missing 2 scans → a normal removal
    const noParent = P.planScan({ rows: [], state, existingParentIds: none })
    expect(noParent.items).toEqual([]) // a reset file whose messages are gone too reports nothing
  })
  it("a non-empty read resets the empty-scan count", () => {
    const state = { ...withAcked(), emptyScans: 4 }
    expect(P.planScan({ rows: [row()], state, existingParentIds: parents }).nextState.emptyScans).toBe(0)
  })
})

describe("absentMessageIds", () => {
  it("lists the parents of reported reactions that are missing from the current picture", () => {
    const state = { acked: { "AAA111|client": {}, "BBB222|line": {}, "CCC333|client": {} }, tries: {}, absent: {} }
    const current = P.currentReactions([row({ message_id: "AAA111" })])
    expect(P.absentMessageIds(current, state).sort()).toEqual(["BBB222", "CCC333"])
  })
})

describe("applyResults", () => {
  const plan = {
    items: [
      { ext_id: "AAAA1111", chat: "17274234285", side: "client", op: "set", emoji: "👍" },
      { ext_id: "BBBB2222", chat: "17274234285", side: "client", op: "set", emoji: "❤️" },
      { ext_id: "CCCC3333", chat: "17274234285", side: "line", op: "set", emoji: "😂" },
      { ext_id: "DDDD4444", chat: "17274234285", side: "client", op: "set", emoji: "🙏" },
    ],
    keys: ["AAAA1111|client", "BBBB2222|client", "CCCC3333|line", "DDDD4444|client"],
  }
  const current = new Map(plan.keys.map((k, i) => [k, { ts: `t${i}` }]))
  it("acknowledges applied / noop / stale, leaves held and unmatched to be retried", () => {
    const st = P.applyResults({ state: P.emptyState(), plan, current, results: [{ i: 0, r: "applied" }, { i: 1, r: "held" }, { i: 2, r: "unmatched" }, { i: 3, r: "stale" }] })
    expect(Object.keys(st.acked).sort()).toEqual(["AAAA1111|client", "DDDD4444|client"])
    expect(st.tries["CCCC3333|line"]).toBe(1)
    expect(st.acked["BBBB2222|client"]).toBeUndefined()
  })
  it("gives up on a message the CRM never gets after MAX_UNMATCHED_TRIES, and drops invalid items for good", () => {
    let st = { acked: {}, tries: { "CCCC3333|line": P.MAX_UNMATCHED_TRIES - 1 }, absent: {} }
    st = P.applyResults({ state: st, plan, current, results: [{ i: 2, r: "unmatched" }, { i: 1, r: "invalid" }] })
    expect(st.acked["CCCC3333|line"]).toBeDefined()
    expect(st.tries["CCCC3333|line"]).toBeUndefined()
    expect(st.acked["BBBB2222|client"]).toBeDefined()
  })
  it("a removal that is applied clears the entry; one that is held stays to be retried", () => {
    const state = { acked: { "AAAA1111|client": { emoji: "👍", ts: "t", chat: "17274234285" } }, tries: {}, absent: { "AAAA1111|client": 2 } }
    const rem = { items: [{ ext_id: "AAAA1111", chat: "17274234285", side: "client", op: "remove" }], keys: ["AAAA1111|client"] }
    expect(P.applyResults({ state, plan: rem, current, results: [{ i: 0, r: "applied" }] }).acked["AAAA1111|client"]).toBeUndefined()
    expect(P.applyResults({ state, plan: rem, current, results: [{ i: 0, r: "held" }] }).acked["AAAA1111|client"]).toBeDefined()
  })
})

describe("toBatches and fingerprintOk", () => {
  it("splits into CRM-sized batches keeping items and keys aligned", () => {
    const items = Array.from({ length: 450 }, (_, i) => ({ n: i }))
    const keys = items.map((_, i) => `k${i}`)
    const b = P.toBatches(items, keys)
    expect(b.map((x: { items: unknown[] }) => x.items.length)).toEqual([200, 200, 50])
    expect(b[2].keys[0]).toBe("k400")
  })
  it("fails closed unless the reaction table has exactly the expected columns", () => {
    expect(P.fingerprintOk([...P.EXPECTED_REACTION_COLUMNS])).toBe(true)
    expect(P.fingerprintOk([...P.EXPECTED_REACTION_COLUMNS, "extra"])).toBe(false)
    expect(P.fingerprintOk(P.EXPECTED_REACTION_COLUMNS.slice(1))).toBe(false)
    expect(P.fingerprintOk([])).toBe(false)
  })
})
