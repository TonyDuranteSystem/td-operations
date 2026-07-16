import { describe, it, expect } from "vitest"
import {
  reconcileConversations,
  makeHiddenOverride,
  makePinnedOverride,
  makeUnreadOverride,
  makeStub,
  DEFAULT_RECONCILE_CONFIG,
  type RowOverride,
  type UnreadOverride,
  type ConversationsPayload,
} from "@/lib/inbox/conversation-reconcile"
import type { InboxConversation } from "@/lib/types"
import { viewKey, type InboxView } from "@/lib/inbox/view-query"

/** The list every legacy test implicitly models: the default Gmail Inbox, support mailbox. */
const SCOPE = { mailbox: "support", channel: "gmail" }
const INBOX_KEY = viewKey({ kind: "inbox" }, SCOPE)
const originOf = (view: InboxView) => ({ view, scope: SCOPE })

// ── fixtures ──
function conv(id: string, over: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: id.startsWith("gmail:") ? id : `gmail:${id}`,
    channel: "gmail",
    name: `Name ${id}`,
    preview: `preview ${id}`,
    unread: 0,
    lastMessageAt: "2026-07-13T10:00:00.000Z",
    subject: `Subject ${id}`,
    accountId: null,
    accountName: null,
    hasAttachment: false,
    colorMark: null,
    ...over,
  }
}
function payload(rows: InboxConversation[], extra: Partial<ConversationsPayload> = {}): ConversationsPayload {
  return { conversations: rows, ...extra }
}
function run(
  p: ConversationsPayload,
  opts: {
    overrides?: Map<string, RowOverride>
    unread?: Map<string, UnreadOverride>
    prev?: Map<string, InboxConversation>
    now?: number
    config?: Partial<typeof DEFAULT_RECONCILE_CONFIG>
    view?: InboxView
  } = {},
) {
  return reconcileConversations({
    payload: p,
    origin: originOf(opts.view ?? { kind: "inbox" }),
    overrides: opts.overrides ?? new Map(),
    unread: opts.unread ?? new Map(),
    prev: opts.prev ?? new Map(),
    now: opts.now ?? 1_000_000,
    config: opts.config,
  })
}
const ids = (r: { visible: InboxConversation[] }) => r.visible.map((c) => c.id)

describe("reconcileConversations — baseline", () => {
  it("passes server rows through untouched with no overrides", () => {
    const r = run(payload([conv("a"), conv("b")]))
    expect(ids(r)).toEqual(["gmail:a", "gmail:b"])
  })

  it("sorts by lastMessageAt desc", () => {
    const r = run(
      payload([
        conv("old", { lastMessageAt: "2026-07-10T00:00:00.000Z" }),
        conv("new", { lastMessageAt: "2026-07-13T00:00:00.000Z" }),
      ]),
    )
    expect(ids(r)).toEqual(["gmail:new", "gmail:old"])
  })
})

describe("delete (hidden) — never blinks, never pops back", () => {
  it("hides a deleted row even while the server STILL returns it (Gmail lag)", () => {
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    // server still lists a (untrash/trash index lag)
    const r = run(payload([conv("a"), conv("b")]), { overrides, now: 2000 })
    expect(ids(r)).toEqual(["gmail:b"]) // a hidden
    // and it is NOT released while the server still contains it
    expect(r.overrides.get("gmail:a")?.kind).toBe("hidden")
    expect(r.overrides.get("gmail:a")?.releasedAt).toBeUndefined()
  })

  it("releases the hide only after `stability` AFFIRMATIVELY-absent complete payloads", () => {
    let overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    // round 1: a absent (complete payload) → agree=1, still hidden, not released
    let r = run(payload([conv("b")]), { overrides, now: 2000 })
    expect(r.overrides.get("gmail:a")?.agree).toBe(1)
    expect(r.overrides.get("gmail:a")?.releasedAt).toBeUndefined()
    // round 2: a absent again → agree=2 == stability → released (tombstone set)
    overrides = r.overrides
    r = run(payload([conv("b")]), { overrides, now: 3000 })
    expect(r.overrides.get("gmail:a")?.releasedAt).toBe(3000)
  })

  it("does NOT release the hide on a PARTIAL payload (absence isn't affirmative)", () => {
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    const r = run(payload([conv("b")], { partial: true }), { overrides, now: 2000 })
    expect(r.overrides.get("gmail:a")?.agree).toBe(0) // no progress toward release
  })

  it("does NOT release the hide when the id is UNENRICHED (fetch failed, not gone)", () => {
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { overrides, now: 2000 })
    expect(r.overrides.get("gmail:a")?.agree).toBe(0)
  })

  it("after release, a tombstone SUPPRESSES a Gmail non-monotonic re-appearance for one cycle", () => {
    // released override with a fresh tombstone
    const released: RowOverride = { kind: "hidden", createdAt: 1000, agree: 2, disagree: 0, releasedAt: 3000 }
    const overrides = new Map([["gmail:a", released]])
    // server flaps `a` back into INBOX right after release
    const r = run(payload([conv("a"), conv("b")]), { overrides, now: 3000 + 10_000 })
    expect(ids(r)).toEqual(["gmail:b"]) // still suppressed — no pop-back
    expect(r.overrides.has("gmail:a")).toBe(true)
  })

  it("forgets the tombstone after tombstoneMs (id can legitimately return later)", () => {
    const released: RowOverride = { kind: "hidden", createdAt: 1000, agree: 2, disagree: 0, releasedAt: 3000 }
    const overrides = new Map([["gmail:a", released]])
    const now = 3000 + DEFAULT_RECONCILE_CONFIG.tombstoneMs + 1
    const r = run(payload([conv("a")]), { overrides, now })
    expect(ids(r)).toEqual(["gmail:a"]) // tombstone expired, row allowed back
    expect(r.overrides.has("gmail:a")).toBe(false)
  })

  it("retires a hide at the TTL THROUGH the tombstone — never a bare drop", () => {
    // The TTL is the honest end for a hide no payload can confirm (archive from
    // a folder leaves the row in that folder, so no view can ever witness it).
    // Dropping it bare here would pop the row straight back while Gmail lags —
    // the original bug. It must retire the same monotone way a confirmed hide does.
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    const now = 1000 + DEFAULT_RECONCILE_CONFIG.ttlMs + 1
    const r = run(payload([conv("a")]), { overrides, now })
    expect(ids(r)).toEqual([]) // still hidden — now in the tombstone phase
    expect(r.overrides.get("gmail:a")?.releasedAt).toBe(now)

    // …and it does finally let go, one tombstone later.
    const later = now + DEFAULT_RECONCILE_CONFIG.tombstoneMs + 1
    const r2 = run(payload([conv("a")]), { overrides: r.overrides, now: later })
    expect(ids(r2)).toEqual(["gmail:a"])
    expect(r2.overrides.has("gmail:a")).toBe(false)
  })

  it("expires a PIN at the TTL (the row is real — the server owns it from here)", () => {
    const overrides = new Map([["gmail:a", makePinnedOverride(1000, INBOX_KEY, conv("a"))]])
    const now = 1000 + DEFAULT_RECONCILE_CONFIG.ttlMs + 1
    const r = run(payload([conv("a")]), { overrides, now })
    expect(ids(r)).toEqual(["gmail:a"])
    expect(r.overrides.has("gmail:a")).toBe(false)
  })

  it("a hide is judged ONLY by the list it was made in", () => {
    // The core rule. Absence from a list the row was never in is not evidence.
    // Luca bulk-deletes in the Inbox, then glances at a folder: those payloads
    // must not confirm anything, or the tombstone expires and all 12 come back.
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    const foreign = run(payload([conv("b")]), { overrides, now: 2000, view: { kind: "label", label: "Sent" } })
    expect(foreign.overrides.get("gmail:a")?.agree).toBe(0) // untouched
    expect(foreign.overrides.get("gmail:a")?.releasedAt).toBeUndefined()
    // …while the Inbox's own payload still judges it normally.
    const home = run(payload([conv("b")]), { overrides, now: 2000 })
    expect(home.overrides.get("gmail:a")?.agree).toBe(1)
  })
})

describe("restore (pinned) — stays visible until the server confirms it's back", () => {
  it("keeps a restored row visible even when the server OMITS it (untrash lag), via snapshot", () => {
    const overrides = new Map([["gmail:a", makePinnedOverride(1000, INBOX_KEY, conv("a", { name: "Restored A" }))]])
    // server hasn't re-indexed the untrash yet → a absent
    const r = run(payload([conv("b")]), { overrides, now: 2000 })
    expect(ids(r)).toContain("gmail:a")
    expect(r.visible.find((c) => c.id === "gmail:a")?.name).toBe("Restored A")
    expect(r.overrides.get("gmail:a")?.kind).toBe("pinned") // still pinned
  })

  it("releases the pin once the server AFFIRMATIVELY contains it, stably", () => {
    let overrides = new Map([["gmail:a", makePinnedOverride(1000, INBOX_KEY, conv("a"))]])
    let r = run(payload([conv("a")]), { overrides, now: 2000 }) // present, agree=1
    expect(r.overrides.get("gmail:a")?.agree).toBe(1)
    overrides = r.overrides
    r = run(payload([conv("a")]), { overrides, now: 3000 }) // present again → release
    expect(r.overrides.has("gmail:a")).toBe(false)
    expect(ids(r)).toEqual(["gmail:a"]) // now sourced from the server
  })

  it("drops a pin that the server AFFIRMATIVELY lacks past the stale cap (deleted elsewhere)", () => {
    const created = 1000
    const ov: RowOverride = { kind: "pinned", originView: INBOX_KEY, snapshot: conv("a"), createdAt: created, agree: 0, disagree: 1 }
    const overrides = new Map([["gmail:a", ov]])
    const now = created + DEFAULT_RECONCILE_CONFIG.stalePinMs + 1
    // affirmatively absent again (complete payload) → disagree hits stability past stale cap → drop
    const r = run(payload([conv("b")]), { overrides, now })
    expect(r.overrides.has("gmail:a")).toBe(false)
    expect(ids(r)).toEqual(["gmail:b"]) // pin dropped, row gone
  })

  it("does NOT drop a pin merely because the id is unenriched (unknown, not gone)", () => {
    const ov = makePinnedOverride(1000, INBOX_KEY, conv("a"))
    const overrides = new Map([["gmail:a", ov]])
    const now = 1000 + DEFAULT_RECONCILE_CONFIG.stalePinMs + 1
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { overrides, now })
    expect(ids(r)).toContain("gmail:a") // still pinned/visible
  })
})

describe("unread override — released on baseline MOVE, never mid-lag", () => {
  it("holds the optimistic value while the server still lags AT the baseline", () => {
    // marked read: value 0, baseline was 1; server still returns 1 (lag)
    const unread = new Map([["gmail:a", makeUnreadOverride(0, 1, 1000)]])
    const r = run(payload([conv("a", { unread: 1 })]), { unread, now: 2000 })
    expect(r.visible.find((c) => c.id === "gmail:a")?.unread).toBe(0) // shows read
    expect(r.unread.has("gmail:a")).toBe(true) // override held (NOT flickered back)
  })

  it("releases when the server CATCHES UP to the optimistic value", () => {
    const unread = new Map([["gmail:a", makeUnreadOverride(0, 1, 1000)]])
    const r = run(payload([conv("a", { unread: 0 })]), { unread, now: 2000 })
    expect(r.unread.has("gmail:a")).toBe(false) // released — server agrees
    expect(r.visible.find((c) => c.id === "gmail:a")?.unread).toBe(0)
  })

  it("releases on GENUINE new activity (server moves off baseline to a new value)", () => {
    // marked read (0, baseline 1); a new reply arrives → server unread = 2
    const unread = new Map([["gmail:a", makeUnreadOverride(0, 1, 1000)]])
    const r = run(payload([conv("a", { unread: 2 })]), { unread, now: 2000 })
    expect(r.unread.has("gmail:a")).toBe(false) // released — new unread not suppressed
    expect(r.visible.find((c) => c.id === "gmail:a")?.unread).toBe(2)
  })

  it("holds the override when the row is absent this round (unenriched/partial)", () => {
    const unread = new Map([["gmail:a", makeUnreadOverride(0, 1, 1000)]])
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { unread, now: 2000 })
    expect(r.unread.has("gmail:a")).toBe(true)
  })

  it("GC-drops an unread override older than the TTL", () => {
    const unread = new Map([["gmail:a", makeUnreadOverride(0, 1, 1000)]])
    const now = 1000 + DEFAULT_RECONCILE_CONFIG.unreadTtlMs + 1
    const r = run(payload([conv("a", { unread: 1 })]), { unread, now })
    expect(r.unread.has("gmail:a")).toBe(false)
  })
})

describe("unenriched threads — carried forward, never hidden", () => {
  it("carries forward the PREVIOUS enriched row when the server couldn't load it", () => {
    const prev = new Map([["gmail:a", conv("a", { name: "Real A", unread: 3 })]])
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { prev, now: 2000 })
    const a = r.visible.find((c) => c.id === "gmail:a")
    expect(a?.name).toBe("Real A") // full data, not a stub
    expect(a?.partial).toBeUndefined()
  })

  it("shows a MARKED stub when there is no previous row to carry forward", () => {
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { now: 2000 })
    const a = r.visible.find((c) => c.id === "gmail:a")
    expect(a).toBeTruthy()
    expect(a?.partial).toBe(true) // visibly marked — can't masquerade as real
    expect(ids(r)).toContain("gmail:a") // NOT hidden
  })

  it("a hidden id that is also unenriched stays hidden (delete wins, no stub)", () => {
    const overrides = new Map([["gmail:a", makeHiddenOverride(1000, "trash", INBOX_KEY, conv("a"))]])
    const r = run(payload([conv("b")], { unenrichedIds: ["gmail:a"] }), { overrides, now: 2000 })
    expect(ids(r)).toEqual(["gmail:b"]) // no stub for a deleted row
  })
})

describe("makeStub", () => {
  it("normalizes a bare thread id to a gmail: id and flags partial", () => {
    const s = makeStub("gmail:x")
    expect(s.id).toBe("gmail:x")
    expect(s.partial).toBe(true)
    expect(s.channel).toBe("gmail")
  })
})
