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
  makeUnreadOverride,
  type RowOverride,
  type UnreadOverride,
  type ConversationsPayload,
  DEFAULT_RECONCILE_CONFIG,
  makeMoveOverrides,
  overrideKey,
} from "@/lib/inbox/conversation-reconcile"
import type { InboxConversation } from "@/lib/types"
import { viewKey, toInboxView, ORIGIN_UNKNOWN, type RowAction, type InboxView } from "@/lib/inbox/view-query"

const SCOPE = { mailbox: "support", channel: "gmail" }
const TRASH_KEY = viewKey({ kind: "trash" }, SCOPE)

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
  /** The view SELECTED in the UI. Flips the instant a folder is clicked. */
  view: InboxView = { kind: "inbox" }
  /** The view the rows ON SCREEN came from — only ever moves when a payload
   *  lands. The real component has BOTH, and they differ for the whole of every
   *  fetch (`keepPreviousData` keeps the old rows visible and clickable). The
   *  harness must model both or it cannot express the bug the council found:
   *  an override stamped with the selection instead of the payload. */
  origin: InboxView = { kind: "inbox" }
  /** Which action the next hide models — trash unless a test says archive. */
  action: RowAction = "trash"

  tick(ms: number) { this.now += ms; return this }
  /** Click a different list. Deliberately does NOT move `origin` — the rows on
   *  screen are still the old list's until the next fetch resolves — and does NOT
   *  clear the overrides. Both are what the shell actually does. */
  viewing(view: InboxView) { this.view = view; return this }
  doing(action: RowAction) { this.action = action; return this }
  /** The key an override gets stamped with = the PAYLOAD's list, never the
   *  selection (inbox-shell's `originViewKey`). */
  private stamp() { return viewKey(this.origin, SCOPE) }

  /** A server refetch lands. */
  fetch(p: ConversationsPayload) {
    this.last = p
    this.origin = this.view // the fetch resolved: the rows on screen are now this view's
    const adv = advanceReleases({ payload: p, origin: { view: this.origin, scope: SCOPE }, overrides: this.overrides, unread: this.unread, prev: this.prev, now: this.now })
    this.overrides = adv.overrides
    this.unread = adv.unread
    this.render()
    return this
  }

  /** Re-render off the last payload (after a user action changed overrides).
   *  Mirrors conversation-list: remember the shown enriched rows AND retain the
   *  last-known row for any overridden id (a hidden row leaves `visible`, but an
   *  Undo needs its data to pin back). */
  render() {
    this.visible = computeVisibleList({ payload: this.last, origin: { view: this.origin, scope: SCOPE }, overrides: this.overrides, unread: this.unread, prev: this.prev, now: this.now })
    const next = new Map<string, InboxConversation>()
    for (const c of this.visible) if (!c.partial) next.set(c.id, c)
    // Read the row off the ENTRY: the map key is opaque (id + view), and two
    // entries can share an id. Keying `prev` by the map key instead of the id
    // silently starves the pin's snapshot fallback — the row comes back as a
    // "Loading…" stub instead of the real email.
    for (const o of Array.from(this.overrides.values())) {
      if (next.has(o.id)) continue
      const keep = this.prev.get(o.id) ?? o.snapshot
      if (keep) next.set(o.id, keep)
    }
    this.prev = next
    return this
  }

  delete(c: InboxConversation) { this.overrides = this.dropClaims(c.id).set(overrideKey(c.id, this.stamp()), makeHiddenOverride(this.now, c.id, this.action, this.stamp(), c)); return this.render() }
  /** Bulk trash/archive: snapshot every selected row into a hidden intent. */
  bulkDelete(cs: InboxConversation[]) {
    let n = this.overrides
    cs.forEach((c) => {
      n = (() => { const m = new Map(n); for (const [k, o] of Array.from(n)) if (o.id === c.id) m.delete(k); return m })()
      n.set(overrideKey(c.id, this.stamp()), makeHiddenOverride(this.now, c.id, this.action, this.stamp(), c))
    })
    this.overrides = new Map(n)
    return this.render()
  }
  bulkUndo(ids: string[]) { ids.forEach((id) => this.undo(id)); return this.render() }
  /** Bulk-delete ids the RAW cache doesn't hold (a carried-forward unenriched or
   *  pinned row) → the hide gets NO snapshot, as the real code would produce. */
  bulkDeleteNoSnapshot(ids: string[]) {
    const n = new Map(this.overrides)
    ids.forEach((id) => { const g = id.startsWith("gmail:") ? id : `gmail:${id}`; n.set(overrideKey(g, this.stamp()), makeHiddenOverride(this.now, g, this.action, this.stamp(), undefined)) })
    this.overrides = n
    return this.render()
  }
  /** Partial-failure guard: drop the whole batch's hides (we don't know which failed). */
  bulkDropHides(ids: string[]) {
    const n = new Map(this.overrides)
    ids.forEach((id) => n.delete(overrideKey(id.startsWith("gmail:") ? id : `gmail:${id}`, this.stamp())))
    this.overrides = n
    return this.render()
  }
  /** Undo = a MOVE: out of Trash, back to the list it was deleted from — the
   *  same `makeMoveOverrides` the shell calls, and the hide it replaces is
   *  removed (a hide would otherwise outrank the pin in its own view). */
  undo(id: string) {
    const gid = id.startsWith("gmail:") ? id : `gmail:${id}`
    let hide: RowOverride | undefined
    for (const o of Array.from(this.overrides.values())) {
      // `action !== "untrash"` mirrors the shell's findHide: a restore is not a
      // delete, so it can never answer "where was this deleted from?".
      if (o.id === gid && o.kind === "hidden" && !o.releasedAt && o.action !== "untrash") hide = o
    }
    // Mirror the shell exactly: no delete to undo → NO-OP. Dropping claims before
    // this check wiped the pin a previous Undo had just created.
    if (!hide) return this.render()
    const n = this.dropClaims(gid)
    for (const [k, ov] of makeMoveOverrides({
      now: this.now, id: gid, action: "untrash",
      from: TRASH_KEY, to: hide.originView ?? null, snapshot: hide.snapshot,
    })) n.set(k, ov)
    this.overrides = n
    return this.render()
  }
  /** Restore FROM Trash to a chosen destination (the shell's handleRestoredTo).
   *  Drops every prior claim first — including the hide from the list the row was
   *  deleted in, which still applies wherever a trash removes a row and would
   *  outrank the pin. */
  restoreTo(c: InboxConversation, dest: InboxView) {
    const n = this.dropClaims(c.id)
    for (const [k, ov] of makeMoveOverrides({
      now: this.now, id: c.id, action: "untrash",
      from: TRASH_KEY, to: viewKey(dest, SCOPE), snapshot: c,
    })) n.set(k, ov)
    this.overrides = n
    return this.render()
  }
  /** The shell's restore onError: roll the optimistic move back. */
  restoreFailed(id: string) { this.overrides = this.dropClaims(id.startsWith("gmail:") ? id : `gmail:${id}`); return this.render() }
  /** The shell's `dropClaimsFor`: a new intent supersedes every prior claim. */
  private dropClaims(id: string) {
    const n = new Map(this.overrides)
    for (const [k, o] of Array.from(this.overrides)) if (o.id === id) n.delete(k)
    return n
  }
  /** Delete the OPEN email from the toolbar. Unlike a row click, `selected` can
   *  outlive its list (clear the search and the pane reverts to the Inbox while
   *  the email stays open), so it is stamped with the origin captured when it
   *  was OPENED — passed here explicitly, as the real mutation variable is. */
  deleteOpen(c: InboxConversation, openedFrom: string) {
    this.overrides = new Map(this.overrides).set(overrideKey(c.id, openedFrom), makeHiddenOverride(this.now, c.id, this.action, openedFrom, c))
    return this.render()
  }
  open(c: InboxConversation) { this.unread = new Map(this.unread).set(c.id, makeUnreadOverride(0, c.unread, this.now)); return this.render() }

  /** The live (non-tombstoned or tombstoned) override for a row, whatever list
   *  it belongs to — the map key is opaque, so look it up by the entry's id. */
  hideOf(id: string) {
    const gid = id.startsWith("gmail:") ? id : `gmail:${id}`
    for (const o of Array.from(this.overrides.values())) if (o.id === gid && o.kind === "hidden") return o
    return undefined
  }
  pinOf(id: string) {
    const gid = id.startsWith("gmail:") ? id : `gmail:${id}`
    for (const o of Array.from(this.overrides.values())) if (o.id === gid && o.kind === "pinned") return o
    return undefined
  }
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
    expect(c.pinOf("A")).toBeUndefined() // pin released, now server-sourced
    // The Undo also left a hide keeping A OUT of Trash — correct, and it is
    // still pending because no Trash payload has landed to witness it. That is
    // the point of one-witness-per-half: the Inbox catching up says nothing
    // about whether Trash has.
    expect(c.hideOf("A")?.action).toBe("untrash")
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

describe("E2E: BULK delete/undo now behaves like the single path", () => {
  it("bulk-deleted rows never pop back while Gmail's index lags", () => {
    const A = conv("A"), B = conv("B"), C = conv("C")
    const c = new InboxClient()
    c.fetch(payload([A, B, C]))
    c.bulkDelete([A, B]) // select A+B → delete
    expect(c.ids()).toEqual(["gmail:C"])
    // the push refetch lands while Gmail still lists A+B (trash-index lag)
    c.tick(2500).fetch(payload([A, B, C]))
    expect(c.ids()).toEqual(["gmail:C"]) // no pop-back (old bug: both returned)
    // Gmail catches up → two stable-absent rounds release the hides
    c.tick(POLL).fetch(payload([C])); expect(c.ids()).toEqual(["gmail:C"])
    c.tick(POLL).fetch(payload([C])); expect(c.ids()).toEqual(["gmail:C"])
  })

  it("bulk Undo brings every row back and they STAY through the untrash lag", () => {
    const A = conv("A"), B = conv("B"), C = conv("C")
    const c = new InboxClient()
    c.fetch(payload([A, B, C]))
    c.bulkDelete([A, B])
    c.tick(1000).bulkUndo(["gmail:A", "gmail:B"])
    expect(c.has("A")).toBe(true); expect(c.has("B")).toBe(true) // instantly back

    // server hasn't re-indexed the untrash → omits A+B. They must STAY.
    c.tick(3000).fetch(payload([C]))
    expect(c.has("A")).toBe(true); expect(c.has("B")).toBe(true) // old bug: invisible ~1min
    c.tick(POLL).fetch(payload([C]))
    expect(c.has("A")).toBe(true); expect(c.has("B")).toBe(true)

    // Gmail catches up → pins release, rows now server-sourced, never blinked
    c.tick(POLL).fetch(payload([A, B, C])); expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([A, B, C]))
    expect(c.has("A")).toBe(true); expect(c.has("B")).toBe(true)
    // Both pins are released — the rows are server-sourced now.
    expect(c.pinOf("A")).toBeUndefined(); expect(c.pinOf("B")).toBeUndefined()
    // What remains is each row's `untrash` hide holding it OUT of Trash. Still
    // pending, correctly: no Trash payload has landed to witness them, and the
    // Inbox catching up says nothing about whether Trash has.
    expect(c.hideOf("A")?.action).toBe("untrash")
    expect(c.hideOf("B")?.action).toBe("untrash")
  })

  it("bulk-deleting a row Gmail couldn't load still restores VISIBLY on Undo", () => {
    // The row the user ticks may be a CARRIED-FORWARD (unenriched) row — it is
    // rendered from the list's last-known copy and is NOT in the raw payload, so
    // the hide gets no snapshot. Undo must still bring it back on screen.
    const A = conv("A", { name: "Real A" }), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    c.tick(POLL).fetch(payload([B], { unenrichedIds: ["gmail:A"] })) // A carried forward
    expect(c.has("A")).toBe(true)

    c.bulkDeleteNoSnapshot(["gmail:A"]) // raw cache had no A → hide without snapshot
    expect(c.has("A")).toBe(false)

    c.tick(1000).undo("gmail:A")
    expect(c.has("A")).toBe(true) // restored VISIBLY (old bug: invisible until Gmail caught up)
    expect(c.visible.find((x) => x.id === "gmail:A")?.name).toBe("Real A") // real data, not a stub
  })

  it("PARTIAL FAILURE: dropping the batch's hides never leaves a live email invisible", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient()
    c.fetch(payload([A, B]))
    c.bulkDelete([A, B])
    expect(c.ids()).toEqual([]) // both optimistically hidden
    // the route reports "1 failed" but not WHICH → drop the whole batch's hides
    c.bulkDropHides(["gmail:A", "gmail:B"])
    c.tick(500).fetch(payload([A, B])) // refetch shows the true state
    expect(c.has("A")).toBe(true)
    expect(c.has("B")).toBe(true) // the one that survived is NOT hidden
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
    expect(c.hideOf("A")?.agree).toBe(0)
    expect(c.has("A")).toBe(false) // still hidden (user deleted it), correctly
    // a restored pin also survives a partial round
    c.undo("A")
    c.tick(POLL).fetch(payload([], { partial: true }))
    expect(c.has("A")).toBe(true) // pin held through the outage
  })
})

/**
 * The cross-view leak (Luca, 2026-07-15). Before the action/view keying, a hide
 * was a bare "this row is gone" claim with no record of WHAT was done or WHERE —
 * so it leaked into every other list, and the archive-in-a-folder case created a
 * hide the folder's own query could never confirm.
 */
describe("E2E: an optimistic hide is judged by what the action does to THIS view", () => {
  it("archive from a user label does NOT hide the row — the label survives archiving", () => {
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "label", label: "Clients/Acme" }).doing("archive")
    c.fetch(payload([A]))
    c.delete(A)
    // The row legitimately stays: `in:clients/acme -in:trash` still matches it.
    // The old code hid it, then popped it back when the TTL expired with no
    // tombstone — the bug Luca reported.
    expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([A]))
    expect(c.has("A")).toBe(true) // and no blink on the next poll
  })

  it("trash from a user label DOES hide the row — `-in:trash` excludes it", () => {
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "label", label: "Clients/Acme" }).doing("trash")
    c.fetch(payload([A]))
    c.delete(A)
    expect(c.has("A")).toBe(false)
  })

  it("archive from the Inbox hides it — the sidebar's Inbox IS the default Inbox", () => {
    // `{kind:'label',label:'INBOX'}` is no longer reachable: toInboxView collapses
    // it into `{kind:'inbox'}` so the list has ONE identity (two keys for one list
    // meant a restored email wouldn't appear in the Inbox you were looking at).
    // Both entry points must therefore behave identically here.
    for (const label of [null, "INBOX"]) {
      const A = conv("A")
      const c = new InboxClient().viewing(toInboxView({ label, search: null })).doing("archive")
      c.fetch(payload([A]))
      c.delete(A)
      expect(c.has("A")).toBe(false)
    }
  })

  it("a row deleted in the Inbox still SHOWS in Trash — the hide does not leak across", () => {
    const A = conv("A")
    const c = new InboxClient().fetch(payload([A]))
    c.delete(A) // in the Inbox: hidden, correctly
    expect(c.has("A")).toBe(false)
    // Luca switches to Trash. Gmail has now indexed the delete, so A is in the
    // payload — and Trash is exactly where he expects to find it.
    c.viewing({ kind: "trash" }).tick(POLL).fetch(payload([A]))
    expect(c.has("A")).toBe(true)
    // Switching back to the Inbox, the hide still applies there.
    c.viewing({ kind: "inbox" }).fetch(payload([]))
    expect(c.has("A")).toBe(false)
  })

  it("a Trash payload cannot release an Inbox hide — it can't speak for that list", () => {
    const A = conv("A")
    const c = new InboxClient().fetch(payload([A]))
    c.delete(A)
    // In Trash, A is PRESENT — which under the old code read as "the server
    // disagrees with the hide" and would have counted toward popping it back.
    c.viewing({ kind: "trash" })
    c.tick(POLL).fetch(payload([A]))
    c.tick(POLL).fetch(payload([A]))
    const ov = c.hideOf("A")
    expect(ov?.disagree).toBe(0)
    expect(ov?.agree).toBe(0) // untouched: not judgeable from here
    c.viewing({ kind: "inbox" }).fetch(payload([]))
    expect(c.has("A")).toBe(false) // and it's still hidden where it belongs
  })
})

describe("E2E: a restore pin belongs to the view that produced its snapshot", () => {
  it("does not inject a restored Inbox row into Starred", () => {
    const A = conv("A")
    const c = new InboxClient().fetch(payload([A]))
    c.delete(A)
    c.undo("A") // pinned back into the Inbox
    expect(c.has("A")).toBe(true)
    // Starred is a different list. A was never starred — pinning it here would
    // show Luca an email that does not belong to the list he opened.
    c.viewing({ kind: "label", label: "STARRED" }).fetch(payload([]))
    expect(c.has("A")).toBe(false)
    // Back in the Inbox, the pin still holds through the Gmail lag.
    c.viewing({ kind: "inbox" }).fetch(payload([]))
    expect(c.has("A")).toBe(true)
  })
})

/**
 * The write-side skew (council round 2, 2026-07-16). `keepPreviousData` keeps the
 * previous list on screen — and fully clickable — for the whole of the next
 * view's fetch. So "the view Luca selected" and "the list he is looking at" are
 * routinely different, and an override must be stamped with the LATTER.
 */
describe("E2E: an override is stamped with the list the rows came from, not the one just clicked", () => {
  it("a delete during a folder's fetch belongs to the INBOX — the folder can neither confirm nor show it", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))

    // Luca clicks "Clients/Acme". The fetch is in flight, so the INBOX rows are
    // still on screen — and he deletes one of them.
    c.viewing({ kind: "label", label: "Clients/Acme" })
    c.delete(A)
    expect(c.has("A")).toBe(false) // hidden immediately, as always

    // The folder's payload lands. A was NEVER in this folder, so its absence
    // here proves nothing: it must NOT count toward releasing the hide.
    c.tick(2000).fetch(payload([]))
    expect(c.hideOf("A")?.agree).toBe(0)
    c.tick(POLL).fetch(payload([]))
    expect(c.hideOf("A")?.agree).toBe(0)
    expect(c.hideOf("A")?.releasedAt).toBeUndefined() // never released by a non-witness

    // Back in the Inbox — the list that actually held it — it judges normally.
    c.viewing({ kind: "inbox" }).tick(POLL).fetch(payload([B]))
    expect(c.hideOf("A")?.agree).toBe(1)
  })

  it("Undo after that delete restores into the INBOX, and never into the folder", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))
    c.viewing({ kind: "label", label: "Clients/Acme" })
    c.delete(A)
    c.tick(1000).undo("A")

    // The folder's payload lands. A is a plain Inbox email — pinning it here
    // would render it inside a folder it was never filed in, for minutes.
    c.tick(1000).fetch(payload([]))
    expect(c.has("A")).toBe(false)

    // Back in the Inbox the pin does its job: A stays visible through the
    // untrash lag, which is the whole reason pins exist.
    c.viewing({ kind: "inbox" }).tick(POLL).fetch(payload([B]))
    expect(c.has("A")).toBe(true)
  })

  it("bulk: a selection made in the Inbox and deleted after clicking a folder still belongs to the Inbox", () => {
    // The bulk bar survives a view change (the shell does not clear the
    // selection), so this needs no race at all — just select, click, delete.
    const A = conv("A"), B = conv("B"), C = conv("C")
    const c = new InboxClient().fetch(payload([A, B, C]))
    c.viewing({ kind: "label", label: "Clients/Acme" })
    c.bulkDelete([A, B])

    c.tick(2000).fetch(payload([])) // folder payload — not a witness
    expect(c.hideOf("A")?.agree).toBe(0)
    expect(c.hideOf("B")?.agree).toBe(0)

    // A bulk Undo here must not inject two Inbox emails into the folder.
    c.bulkUndo(["A", "B"])
    c.tick(1000).fetch(payload([]))
    expect(c.has("A")).toBe(false)
    expect(c.has("B")).toBe(false)

    // …and must restore them where they belong.
    c.viewing({ kind: "inbox" }).tick(POLL).fetch(payload([C]))
    expect(c.has("A")).toBe(true)
    expect(c.has("B")).toBe(true)
  })
})

/**
 * The reading pane is a SECOND row source, and it outlives its list (council
 * round 3). An email opened from a search stays open when the search is cleared;
 * a ?thread= deep link opens one with no list behind it at all.
 */
describe("E2E: the open email is stamped with the list it was OPENED from", () => {
  it("deleting a cleared-search result is not 'confirmed' by the Inbox, and Undo never injects it there", () => {
    // A is an archived email — findable by an all-mail search, not in the Inbox.
    const A = conv("A"), B = conv("B")
    const c = new InboxClient()
    const searchView: InboxView = { kind: "search", query: "invoice" }
    c.viewing(searchView).fetch(payload([A]))
    const openedFrom = viewKey(searchView, SCOPE) // captured when Luca opens A

    // He clears the search: the pane reverts to the Inbox, A stays open.
    c.viewing({ kind: "inbox" }).fetch(payload([B]))
    c.deleteOpen(A, openedFrom)

    // The Inbox never held A. Its absence here must prove nothing.
    c.tick(POLL).fetch(payload([B]))
    c.tick(POLL).fetch(payload([B]))
    expect(c.hideOf("A")?.agree).toBe(0)
    expect(c.hideOf("A")?.releasedAt).toBeUndefined()

    // And an Undo must not put an archived email into the Inbox list.
    c.undo("A")
    c.tick(1000).fetch(payload([B]))
    expect(c.has("A")).toBe(false)

    // Back in the search that found it, the pin does its job.
    c.viewing(searchView).tick(POLL).fetch(payload([]))
    expect(c.has("A")).toBe(true)
  })

  it("a deep-linked email has no list — it hides, is judged by nobody, and retires via the tombstone", () => {
    // Opened straight from a Team share card: there is no payload behind it, so
    // the honest answer is 'unknown'. It must NOT be attributed to the Inbox.
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))
    c.deleteOpen(A, ORIGIN_UNKNOWN)
    expect(c.has("A")).toBe(false) // still hides — that is action-derived

    // No list can confirm it, not even the one it happens to be in.
    c.tick(POLL).fetch(payload([B]))
    expect(c.hideOf("A")?.agree).toBe(0)

    // It retires monotonically through the tombstone, never a bare drop.
    c.tick(DEFAULT_RECONCILE_CONFIG.ttlMs).fetch(payload([A, B]))
    expect(c.has("A")).toBe(false)
    expect(c.hideOf("A")?.releasedAt).toBe(c.now)
    c.tick(DEFAULT_RECONCILE_CONFIG.tombstoneMs + 1).fetch(payload([A, B]))
    expect(c.hideOf("A")).toBeUndefined()
  })
})

/**
 * RESTORE FROM TRASH (Antonio, 2026-07-16): *"there is a button that says
 * Restore. I click, and I see it in the folder that I decide to restore… with no
 * delay, with no 5 minutes, with nothing. It must work."*
 *
 * A restore is a MOVE: the row leaves Trash AND appears at its destination, both
 * optimistically. Two overrides, one per list, each with its own single witness —
 * because Trash and the destination catch up at different times.
 */
describe("E2E: Restore from Trash — instant in BOTH lists, no waiting on Gmail", () => {
  const INBOX: InboxView = { kind: "inbox" }
  const FOLDER: InboxView = { kind: "label", label: "Label_5" }

  it("leaves Trash the instant it's clicked, and does not come back while Gmail lags", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A, B]))
    expect(c.has("A")).toBe(true) // it IS in Trash — that's why Restore is here

    c.restoreTo(A, INBOX)
    expect(c.has("A")).toBe(false) // gone from Trash immediately

    // Gmail's index still lists it in Trash for 30-60s. It must NOT flicker back.
    c.tick(3000).fetch(payload([A, B])); expect(c.has("A")).toBe(false)
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(false)
    // Gmail catches up; the hide releases and tombstones, still not shown.
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(false)
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(false)
  })

  it("is ALREADY in the Inbox when you get there — not in 5 minutes", () => {
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A]))
    c.restoreTo(A, INBOX)

    // Antonio clicks Inbox. Gmail has NOT re-indexed the untrash, so its payload
    // does not contain A at all. He must still see it — that is the whole ask.
    c.viewing(INBOX).tick(500).fetch(payload([B]))
    expect(c.has("A")).toBe(true)
    // …and it stays put across the whole lag window.
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([B])); expect(c.has("A")).toBe(true)
    // Gmail catches up → the pin releases and the row is server-sourced. Never blinked.
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([A, B])); expect(c.has("A")).toBe(true)
    expect(c.pinOf("A")).toBeUndefined()
  })

  it("restoring INTO a folder puts it in THAT folder, and not in the Inbox", () => {
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A]))
    c.restoreTo(A, FOLDER)

    // The chosen folder shows it at once, through the lag.
    c.viewing(FOLDER).tick(500).fetch(payload([]))
    expect(c.has("A")).toBe(true)

    // The Inbox must NOT: the server drops INBOX when a destination is picked,
    // so pinning it there would show a row that isn't going to be there.
    c.viewing(INBOX).tick(500).fetch(payload([]))
    expect(c.has("A")).toBe(false)
  })

  it("the two halves release independently — Trash catching up doesn't un-pin the Inbox", () => {
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A]))
    c.restoreTo(A, INBOX)

    // Trash re-indexes FIRST and confirms A is gone → its hide releases.
    c.tick(POLL).fetch(payload([])); c.tick(POLL).fetch(payload([]))
    // The Inbox pin is untouched by that — a Trash payload is not its witness.
    const pin = c.pinOf("A")
    expect(pin?.agree).toBe(0)
    // And the Inbox still shows it while ITS index lags.
    c.viewing(INBOX).tick(POLL).fetch(payload([]))
    expect(c.has("A")).toBe(true)
  })

  it("deleting again after a restore wins — the newer intent is the user's", () => {
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A]))
    c.restoreTo(A, INBOX)
    c.viewing(INBOX).tick(500).fetch(payload([]))
    expect(c.has("A")).toBe(true) // pinned back

    // He changes his mind and deletes it from the Inbox. The pin must lose:
    // showing a row he just deleted is the worse failure.
    c.doing("trash").delete(A)
    expect(c.has("A")).toBe(false)
    c.tick(POLL).fetch(payload([]))
    expect(c.has("A")).toBe(false)
  })
})

/**
 * The two blockers the bug-hunter found in the first Restore build. Both were
 * invisible to the tests above because those all start from a clean map with the
 * row only in Trash — a shape the real app rarely has.
 */
describe("E2E: Restore clears the STALE claims a row already carries", () => {
  it("a row deleted from a FOLDER, then restored from Trash, lands in the Inbox — not nowhere", () => {
    // THE BLOCKER: the folder's hide (action 'trash') still applies in the Inbox
    // — a trash removes a row from there too — and a hide outranks a pin. Leaving
    // it meant the email was in NEITHER Trash nor Inbox for up to 6.5 minutes:
    // Antonio's exact sentence, broken.
    const A = conv("A"), B = conv("B")
    const FOLDER: InboxView = { kind: "label", label: "Label_5" }
    const c = new InboxClient().viewing(FOLDER).fetch(payload([A, B]))
    c.delete(A) // deleted from the folder
    expect(c.has("A")).toBe(false)

    // It IS in Trash — that's where he goes to get it back.
    c.viewing({ kind: "trash" }).tick(2000).fetch(payload([A]))
    expect(c.has("A")).toBe(true)
    c.restoreTo(A, { kind: "inbox" })
    expect(c.has("A")).toBe(false) // leaves Trash at once

    // …and it MUST be in the Inbox, immediately, even though Gmail still omits it.
    c.viewing({ kind: "inbox" }).tick(500).fetch(payload([B]))
    expect(c.has("A")).toBe(true)
    c.tick(POLL).fetch(payload([B]))
    expect(c.has("A")).toBe(true)
  })

  it("delete → Undo → delete again → the email IS in Trash, not missing for 5 minutes", () => {
    // The Undo leaves an `untrash` hide holding the row OUT of Trash. Re-deleting
    // puts it genuinely back IN Trash, so that hide is now a false claim — and it
    // could never release (the row is present every round), so only the TTL would
    // clear it: missing from Trash for up to 6.5 min.
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))
    c.delete(A)
    c.tick(1000).undo("gmail:A")
    expect(c.has("A")).toBe(true)

    c.tick(1000).delete(A) // changed his mind
    expect(c.has("A")).toBe(false) // gone from the Inbox

    // Trash must show it.
    c.viewing({ kind: "trash" }).tick(2000).fetch(payload([A]))
    expect(c.has("A")).toBe(true)
  })

  it("clicking Undo twice does not make the restored email disappear", () => {
    // `findHide` answers "where was this deleted from?" and must ignore the
    // restore's OWN `untrash` hide. The toast lives 8s and the button is
    // clickable the whole time, so a second Undo (a double-click, or a stale
    // toast) is ordinary. Without the guard the second Undo matches the untrash
    // hide → `to === from` → the pin is dropped and NOT re-created → the email
    // he just restored vanishes from the Inbox.
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))
    c.delete(A)
    c.tick(500).undo("gmail:A")
    expect(c.has("A")).toBe(true)
    expect(c.pinOf("A")?.originView).toBe(viewKey({ kind: "inbox" }, SCOPE))

    c.tick(200).undo("gmail:A") // clicked again
    expect(c.has("A")).toBe(true) // still there — a second Undo is a no-op
    expect(c.pinOf("A")?.originView).toBe(viewKey({ kind: "inbox" }, SCOPE))
    // …and it stays through the lag, exactly as one Undo would.
    c.tick(POLL).fetch(payload([B]))
    expect(c.has("A")).toBe(true)
  })
})

/**
 * Round 2 findings. Every one of these is a bug that shipped past the previous
 * round's tests because the harness mirrored the shell's OMISSION rather than
 * its intent.
 */
describe("E2E: every intent-writer clears the row's stale claims — including the bulk bar", () => {
  it("undo, then BULK delete → the email is in Trash, not missing for 6 minutes", () => {
    // THE BLOCKER: the bulk bar was the 4th writer and didn't drop claims. The
    // Undo's `untrash` hide survived, holding the row OUT of Trash while it was
    // genuinely IN Trash — unwitnessable, so only the TTL would clear it.
    const A = conv("A"), B = conv("B")
    const c = new InboxClient().fetch(payload([A, B]))
    c.delete(A)
    c.tick(1000).undo("gmail:A")
    expect(c.has("A")).toBe(true) // back in the Inbox

    // He ticks it and uses the bulk Delete bar this time.
    c.tick(1000).bulkDelete([A])
    expect(c.has("A")).toBe(false)

    // Trash must show it — this is where he goes to find it.
    c.viewing({ kind: "trash" }).tick(2000).fetch(payload([A]))
    expect(c.has("A")).toBe(true)
  })

  it("a FAILED restore puts the row back in Trash — you can't retry on an invisible row", () => {
    // The optimistic move fires before the request. If the request fails the
    // email is still in Trash, so leaving the move would hide it from the one
    // list it is in, while the toast says "Failed — try again".
    const A = conv("A")
    const c = new InboxClient().viewing({ kind: "trash" }).fetch(payload([A]))
    c.restoreTo(A, { kind: "inbox" })
    expect(c.has("A")).toBe(false) // optimistically gone

    c.restoreFailed("gmail:A") // the server said no
    expect(c.has("A")).toBe(true) // …and it's visibly back, ready to retry

    // It also must not linger as a phantom pin in the Inbox.
    c.viewing({ kind: "inbox" }).tick(500).fetch(payload([]))
    expect(c.has("A")).toBe(false)
  })
})
