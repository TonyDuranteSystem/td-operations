/**
 * END-TO-END QA for the Inbox flicker fix (Luca, 2026-07-13).
 *
 * A browser click-through can't reliably reproduce Gmail's 30–60s index lag, so
 * this drives the REAL fix code through a simulated lag TIMELINE exactly as the
 * live components do: each server refetch runs `advanceReleases` ONCE, then
 * `computeVisibleList` builds what the screen shows; user actions mutate the
 * overrides and re-render off the last payload. We assert the visible list never
 * blinks a row out/in and never flips a read email back to unread.
 */
import { describe, it, expect } from "vitest"
import {
  advanceReleases,
  computeVisibleList,
  makeHiddenOverride,
  makePinnedOverride,
  makeUnreadOverride,
  type RowOverride,
  type UnreadOverride,
  type ConversationsPayload,
} from "@/lib/inbox/conversation-reconcile"
import type { InboxConversation } from "@/lib/types"

function conv(id: string, over: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: id.startsWith("gmail:") ? id : `gmail:${id}`,
    channel: "gmail",
    name: `Name ${id}`,
    preview: `p ${id}`,
    unread: 0,
    lastMessageAt: "2026-07-13T10:00:00.000Z",
    subject: `S ${id}`,
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

/** Models the two live components' behaviour: advance-once-per-fetch +
 *  compute-per-render, threading the override maps + carry-forward exactly. */
class InboxClient {
  overrides = new Map<string, RowOverride>()
  unread = new Map<string, UnreadOverride>()
  prev = new Map<string, InboxConversation>()
  visible: InboxConversation[] = []
  last: ConversationsPayload = { conversations: [] }
  now = 1_000_000

  tick(ms: number) { this.now += ms; return this }

  /** A server refetch lands. */
  fetch(p: ConversationsPayload) {
    this.last = p
    const adv = advanceReleases({ payload: p, overrides: this.overrides, unread: this.unread, prev: this.prev, now: this.now })
    this.overrides = adv.overrides
    this.unread = adv.unread
    this.render()
    return this
  }

  /** Re-render off the last payload (after a user action changed overrides). */
  render() {
    this.visible = computeVisibleList({ payload: this.last, overrides: this.overrides, unread: this.unread, prev: this.prev, now: this.now })
    const next = new Map<string, InboxConversation>()
    for (const c of this.visible) if (!c.partial) next.set(c.id, c)
    this.prev = next
    return this
  }

  delete(c: InboxConversation) { this.overrides = new Map(this.overrides).set(c.id, makeHiddenOverride(this.now, c)); return this.render() }
  undo(id: string) {
    const gid = id.startsWith("gmail:") ? id : `gmail:${id}`
    const ex = this.overrides.get(gid) // real component always keys by the full id
    this.overrides = new Map(this.overrides).set(gid, makePinnedOverride(this.now, ex?.snapshot))
    return this.render()
  }
  open(c: InboxConversation) { this.unread = new Map(this.unread).set(c.id, makeUnreadOverride(0, c.unread, this.now)); return this.render() }

  ids() { return this.visible.map((c) => c.id) }
  has(id: string) { return this.visible.some((c) => c.id === (id.startsWith("gmail:") ? id : `gmail:${id}`)) }
  unreadOf(id: string) { return this.visible.find((c) => c.id === (id.startsWith("gmail:") ? id : `gmail:${id}`))?.unread }
}

const POLL = 75_000

describe("E2E: delete → Undo → the restored email NEVER vanishes across the untrash lag", () => {
  it("stays visible at every step until Gmail confirms it's back", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    expect(c.ids()).toEqual(["gmail:A", "gmail:B"])

    c.delete(A)
    expect(c.has("A")).toBe(false) // hidden

    c.tick(1500).undo("A")
    expect(c.has("A")).toBe(true) // restored instantly (pinned snapshot)

    // Gmail is still re-indexing the untrash → refetches OMIT A. It must STAY.
    c.tick(3000).fetch(payload([B]));  expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([B]));  expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([B]));  expect(c.has("A")).toBe(true)

    // Gmail catches up → A returns; the pin releases after stable agreement,
    // and A is continuously present the whole time (no vanish, no re-blink).
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(true)
    expect(c.overrides.has("gmail:A")).toBe(false) // pin released, now server-sourced
  })
})

describe("E2E: idle — a thread the server FAILS to load this round does not blink out", () => {
  it("carries the real row forward (not a blank), then settles", () => {
    const A = conv("A", { unread: 3, name: "Real A" }), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    // a poll where A's metadata fetch 429'd → server reports it unenriched
    c.tick(POLL).fetch(payload([B], { unenrichedIds: ["gmail:A"] }))
    expect(c.has("A")).toBe(true) // NOT blinked out
    const a = c.visible.find((x) => x.id === "gmail:A")
    expect(a?.name).toBe("Real A") // real carried-forward data, not a stub
    expect(a?.partial).toBeUndefined()
    // next poll succeeds → still there, no flicker
    c.tick(POLL).fetch(payload([A, B]))
    expect(c.has("A")).toBe(true)
  })

  it("a brand-new unloadable thread shows a MARKED stub, never a hidden email", () => {
    const c = new InboxClient()
    c.fetch(payload([conv("B")], { unenrichedIds: ["gmail:NEW"] }))
    expect(c.has("NEW")).toBe(true)
    expect(c.visible.find((x) => x.id === "gmail:NEW")?.partial).toBe(true)
  })
})

describe("E2E: a deleted email NEVER pops back (Gmail lag + non-monotonic re-appearance)", () => {
  it("stays gone through lag, release, and a tombstoned flap", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    c.delete(A)
    // Gmail still lists A (trash-index lag) across several polls — stays hidden
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(false)
    // Gmail drops A → two stable-absent polls release the hide (+ tombstone)
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(false)
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(false)
    // Gmail's index FLAPS A back in momentarily → tombstone suppresses it
    c.tick(10_000).fetch(payload([A, B])); expect(c.has("A")).toBe(false)
  })
})

describe("E2E: mark-read stays read (the headline flicker) across the label lag", () => {
  it("never flips back to unread while Gmail lags", () => {
    const A = conv("A", { unread: 2 }), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    expect(c.unreadOf("A")).toBe(2)

    c.open(A) // handleSelect → optimistic read
    expect(c.unreadOf("A")).toBe(0)

    // Gmail's UNREAD index lags → refetches STILL say unread:2. Must show 0.
    c.tick(POLL).fetch(payload([conv("A", { unread: 2 }), B])); expect(c.unreadOf("A")).toBe(0)
    c.tick(POLL).fetch(payload([conv("A", { unread: 2 }), B])); expect(c.unreadOf("A")).toBe(0)
    // Gmail catches up → override releases, still reads 0 (no flip to 2 anywhere)
    c.tick(POLL).fetch(payload([conv("A", { unread: 0 }), B])); expect(c.unreadOf("A")).toBe(0)
    expect(c.unread.has("gmail:A")).toBe(false)
  })

  it("a genuinely NEW reply after mark-read is NOT suppressed", () => {
    const A = conv("A", { unread: 1 })
    const c = new InboxClient()
    c.fetch(payload([A]))
    c.open(A)
    expect(c.unreadOf("A")).toBe(0)
    // a real new reply → server unread jumps to 2 (off baseline) → override releases
    c.tick(POLL).fetch(payload([conv("A", { unread: 2 })]))
    expect(c.unreadOf("A")).toBe(2)
  })
})

describe("E2E: a partial/degraded payload freezes releases (nothing dropped mid-outage)", () => {
  it("does not release a hide or pin while the list is incomplete", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    c.delete(A)
    // Gmail rate-limited → partial payload missing A. A must NOT be treated as
    // "confirmed gone" → hide is held, no release progress.
    c.tick(POLL).fetch(payload([B], { partial: true }))
    expect(c.overrides.get("gmail:A")?.agree).toBe(0)
    expect(c.has("A")).toBe(false) // still hidden (user deleted it), correctly
    // a restored pin also survives a partial round
    c.undo("A")
    c.tick(POLL).fetch(payload([], { partial: true }))
    expect(c.has("A")).toBe(true) // pin held through the outage
  })
})
