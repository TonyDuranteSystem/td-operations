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
  it("…but is removed once it has stayed missing for ABSENT_SCANS_BEFORE_REMOVAL scans, with the parent message still present", () => {
    const plan = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state: withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), existingParentIds: parents })
    expect(plan.items.find((i: { op: string }) => i.op === "remove")).toEqual({ ext_id: "3A005FCF60C597CA99D0", chat: "17274234285", side: "client", op: "remove" })
  })
  it("if the PARENT message is gone it is not a removal — the entry is simply forgotten", () => {
    const plan = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state: withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), existingParentIds: none })
    expect(plan.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
    expect(plan.nextState.acked[key]).toBeUndefined()
  })
  it("a reaction that comes back resets the missing count", () => {
    const plan = P.planScan({ rows: [row()], state: withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), existingParentIds: parents })
    expect(plan.nextState.absent[key]).toBeUndefined()
  })
  it("the guard refuses a flood of removals (> 3) and keeps counting; --accept-removals lets a checked batch through", () => {
    const acked: Record<string, unknown> = {}
    const absent: Record<string, number> = {}
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { const id = `MSG${i}AAAA`; ids.push(id); acked[`${id}|client`] = { emoji: "👍", ts: "t", chat: "17274234285" }; absent[`${id}|client`] = P.ABSENT_SCANS_BEFORE_REMOVAL - 1 }
    const state = { acked, tries: {}, absent }
    const refused = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state, existingParentIds: new Set(ids) })
    expect(refused.guard).toEqual({ tripped: true, removals: 5 })
    expect(refused.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
    const allowed = P.planScan({ rows: [row({ message_id: "OTHERMSG01" })], state, existingParentIds: new Set(ids), acceptRemovals: true })
    expect(allowed.items.filter((i: { op: string }) => i.op === "remove")).toHaveLength(5)
  })
  it("an EMPTY read while reactions were reported before is distrusted as a failed read, never 'everything was removed' at once", () => {
    const plan = P.planScan({ rows: [], state: withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), existingParentIds: parents })
    expect(plan.skip).toBe(true)
    expect(plan.items).toEqual([])
    expect(plan.nextState).toEqual({ ...withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), emptyScans: 1 })
  })
  it("…but only for MAX_EMPTY_SCANS in a row: after that a file that really emptied is believed (and cannot wedge the reader)", () => {
    const state = { ...withAcked(P.ABSENT_SCANS_BEFORE_REMOVAL - 1), emptyScans: P.MAX_EMPTY_SCANS }
    const plan = P.planScan({ rows: [], state, existingParentIds: parents })
    expect(plan.skip).toBe(false)
    expect(plan.items.find((i: { op: string }) => i.op === "remove")).toBeDefined() // parent exists + missing long enough → a normal removal
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

describe("paced retries for a reaction on a message the CRM does not have yet", () => {
  const rowsFor = (id: string) => [{ message_id: id, chat_jid: "17274234285@s.whatsapp.net", reactor_jid: "17274234285@s.whatsapp.net", emoji: "👍", is_from_me: 0, reaction_timestamp: "2026-10-07 01:11:03+00:00", updated_at: "2026-10-07 01:11:03+00:00" }]
  const none = new Set<string>()

  it("is re-reported at most once per UNMATCHED_RETRY_MS, however often the loop scans", () => {
    const t0 = 1_000_000
    let state = P.emptyState()
    const first = P.planScan({ rows: rowsFor("UNMATCH0001"), state, existingParentIds: none, now: t0 })
    expect(first.items).toHaveLength(1)
    state = P.applyResults({ state: first.nextState, plan: first, current: first.current, results: [{ i: 0, r: "unmatched" }], now: t0 })
    expect(state.tries["UNMATCH0001|client"]).toBe(1)
    // 10 s and 50 s later: nothing to report
    for (const dt of [10_000, 30_000, P.UNMATCHED_RETRY_MS - 1]) {
      const p = P.planScan({ rows: rowsFor("UNMATCH0001"), state, existingParentIds: none, now: t0 + dt })
      expect(p.items).toHaveLength(0)
      state = p.nextState
    }
    // after the pause it is asked again, and the count keeps rising toward MAX_UNMATCHED_TRIES
    const later = P.planScan({ rows: rowsFor("UNMATCH0001"), state, existingParentIds: none, now: t0 + P.UNMATCHED_RETRY_MS })
    expect(later.items).toHaveLength(1)
  })

  it("an acknowledged reaction forgets its retry bookkeeping", () => {
    const t0 = 5_000
    const first = P.planScan({ rows: rowsFor("UNMATCH0002"), state: P.emptyState(), existingParentIds: none, now: t0 })
    let st = P.applyResults({ state: first.nextState, plan: first, current: first.current, results: [{ i: 0, r: "unmatched" }], now: t0 })
    const again = P.planScan({ rows: rowsFor("UNMATCH0002"), state: st, existingParentIds: none, now: t0 + P.UNMATCHED_RETRY_MS })
    st = P.applyResults({ state: st, plan: again, current: again.current, results: [{ i: 0, r: "applied" }], now: t0 + P.UNMATCHED_RETRY_MS })
    expect(st.tries["UNMATCH0002|client"]).toBeUndefined()
    expect(st.triedAt["UNMATCH0002|client"]).toBeUndefined()
    expect(st.acked["UNMATCH0002|client"]).toBeDefined()
  })

  it("a CHANGED reaction on a still-unmatched message is reported at once (pacing only holds back an identical repeat)", () => {
    const t0 = 9_000
    const first = P.planScan({ rows: rowsFor("UNMATCH0003"), state: P.emptyState(), existingParentIds: none, now: t0 })
    const st = P.applyResults({ state: first.nextState, plan: first, current: first.current, results: [{ i: 0, r: "unmatched" }], now: t0 })
    const changed = rowsFor("UNMATCH0003").map((r) => ({ ...r, emoji: "😂", reaction_timestamp: "2026-10-07 01:12:09+00:00", updated_at: "2026-10-07 01:12:09+00:00" }))
    const p = P.planScan({ rows: changed, state: st, existingParentIds: none, now: t0 + 5_000 })
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ op: "set", emoji: "😂" })
  })

  it("a removal the CRM HELD is asked again at most once per UNMATCHED_RETRY_MS (not every scan), and an applied one is forgotten", () => {
    const key = "HELDMSG0001|client"
    const base = { acked: { [key]: { emoji: "👍", ts: "t", chat: "17274234285" } }, tries: {}, absent: { [key]: P.ABSENT_SCANS_BEFORE_REMOVAL }, emptyScans: 0, triedAt: {}, triedSig: {} }
    const parents = new Set(["HELDMSG0001"])
    const rows = [{ message_id: "OTHERMSG77", chat_jid: "17274234285@s.whatsapp.net", reactor_jid: "x", emoji: "🙏", is_from_me: 0, reaction_timestamp: "t", updated_at: "t" }]
    const t0 = 20_000
    const first = P.planScan({ rows, state: base, existingParentIds: parents, now: t0 })
    expect(first.items.some((i: { op: string }) => i.op === "remove")).toBe(true)
    let st = P.applyResults({ state: first.nextState, plan: first, current: first.current, results: [{ i: first.items.findIndex((i: { op: string }) => i.op === "remove"), r: "held" }], now: t0 })
    for (const dt of [10_000, 40_000]) {
      const p = P.planScan({ rows, state: st, existingParentIds: parents, now: t0 + dt })
      expect(p.items.some((i: { op: string }) => i.op === "remove")).toBe(false)
      st = p.nextState
    }
    const again = P.planScan({ rows, state: st, existingParentIds: parents, now: t0 + P.UNMATCHED_RETRY_MS })
    const idx = again.items.findIndex((i: { op: string }) => i.op === "remove")
    expect(idx).toBeGreaterThanOrEqual(0)
    st = P.applyResults({ state: st, plan: again, current: again.current, results: [{ i: idx, r: "applied" }], now: t0 + P.UNMATCHED_RETRY_MS })
    expect(st.acked[key]).toBeUndefined()
    expect(st.triedAt[key]).toBeUndefined()
  })

  it("the thresholds keep their real-time meaning at 10-second scans", () => {
    expect(P.ABSENT_SCANS_BEFORE_REMOVAL * 10).toBeGreaterThanOrEqual(60) // a vanished reaction must stay gone ~1 minute
    expect(P.MAX_EMPTY_SCANS * 10).toBeGreaterThanOrEqual(600)           // an empty read is distrusted ~10 minutes
  })
})

