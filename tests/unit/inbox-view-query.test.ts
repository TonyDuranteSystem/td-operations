/**
 * The view→query mapping and the hide predicate that reads it.
 *
 * These two must agree or the Inbox creates optimistic hides its own list query
 * can never confirm — the row hangs until the TTL drops it with no tombstone and
 * pops back minutes later. The params table below is a BYTE-FOR-BYTE lock on what
 * the conversations route sends to Gmail: if someone edits a query string, this
 * test fails and they must revisit `removesFromView` in the same breath.
 */
import { describe, it, expect } from "vitest"
import {
  toInboxView,
  viewKey,
  buildGmailQueryParams,
  removesFromView,
  type InboxView,
} from "@/lib/inbox/view-query"

describe("toInboxView", () => {
  it("maps the TRASH label to the trash view, not a generic label", () => {
    expect(toInboxView({ label: "TRASH", search: null })).toEqual({ kind: "trash" })
  })

  it("collapses the INBOX label into the inbox view — ONE list, ONE identity", () => {
    // The sidebar's Inbox button sends the label id 'INBOX'; "no label" also means
    // the Inbox. Two shapes for one list = two view keys, and an override stamped
    // with one is invisible to the other — restore an email and it would not show
    // up in the Inbox you are looking at.
    expect(toInboxView({ label: "INBOX", search: null })).toEqual({ kind: "inbox" })
    expect(toInboxView({ label: "INBOX", search: null })).toEqual(toInboxView({ label: null, search: null }))
  })

  it("gives the sidebar Inbox and the default Inbox the SAME key", () => {
    const fromSidebar = viewKey(toInboxView({ label: "INBOX", search: null }), S)
    const fromDefault = viewKey(toInboxView({ label: null, search: null }), S)
    expect(fromSidebar).toBe(fromDefault)
  })

  it("lets a label WIN over a search — the route's own precedence", () => {
    // A stale string in the search box must not change how we reason about a
    // list the server built from the label alone.
    expect(toInboxView({ label: "STARRED", search: "invoice" })).toEqual({ kind: "label", label: "STARRED" })
  })

  it("uses search only when no label filter is set — inbox-scoped by DEFAULT", () => {
    // Antonio, 2026-08-07: "when I search an email I want to search in inbox
    // and if I want to include the archive I want to have the option."
    expect(toInboxView({ label: null, search: "invoice" })).toEqual({ kind: "search-inbox", query: "invoice" })
    expect(toInboxView({ label: null, search: "invoice", searchScope: "inbox" })).toEqual({ kind: "search-inbox", query: "invoice" })
    expect(toInboxView({ label: null, search: "invoice", searchScope: "all" })).toEqual({ kind: "search-all", query: "invoice" })
  })

  it("maps the Archived sidebar sentinel to the archived view", () => {
    expect(toInboxView({ label: "_ARCHIVED_", search: null })).toEqual({ kind: "archived" })
  })

  it("falls back to the default inbox with neither", () => {
    expect(toInboxView({ label: null, search: null })).toEqual({ kind: "inbox" })
  })

  it("ignores an empty-string label/search rather than building an empty query", () => {
    expect(toInboxView({ label: "", search: "" })).toEqual({ kind: "inbox" })
  })
})

const S = { mailbox: "support", channel: "gmail" }

describe("viewKey", () => {
  it("separates views that show different rows", () => {
    const keys = [
      viewKey({ kind: "inbox" }, S),
      viewKey({ kind: "trash" }, S),
      viewKey({ kind: "label", label: "STARRED" }, S),
      viewKey({ kind: "label", label: "INBOX" }, S),
      viewKey({ kind: "search-inbox", query: "invoice" }, S),
      viewKey({ kind: "search-all", query: "invoice" }, S),
      viewKey({ kind: "archived" }, S),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("separates the same view across mailboxes — a different id-universe", () => {
    expect(viewKey({ kind: "inbox" }, S)).not.toBe(viewKey({ kind: "inbox" }, { mailbox: "antonio", channel: "gmail" }))
  })
})

describe("buildGmailQueryParams", () => {
  // Byte-exact: these are the strings the route sends to Gmail today.
  const cases: Array<[string, InboxView, { labelIds?: string; q?: string; indexOnly?: true }]> = [
    ["default inbox → labelIds INBOX", { kind: "inbox" }, { labelIds: "INBOX" }],
    ["trash → labelIds TRASH", { kind: "trash" }, { labelIds: "TRASH" }],
    // A label view filters by the label's ID and excludes trash via `q`.
    // `in:<id>` matched NOTHING (verified live: in:label_5 → 0, in:_archive → ~201),
    // which is why every custom folder listed zero emails. Never build the label
    // query from a NAME: `view.label` is an id, and the id is this view's identity
    // everywhere else (viewKey keys on it).
    ["label → labelIds + -in:trash", { kind: "label", label: "STARRED" }, { labelIds: "STARRED", q: "-in:trash" }],
    // The case that was broken: a real user-folder id, which is NOT its name.
    ["user folder → its ID, never its name", { kind: "label", label: "Label_5" }, { labelIds: "Label_5", q: "-in:trash" }],
    // Names with spaces/slashes need no quoting or escaping under labelIds.
    ["nested user folder", { kind: "label", label: "Label_7" }, { labelIds: "Label_7", q: "-in:trash" }],
    // Inbox-scoped search (the default): in:inbox joins the query…
    ["search-inbox → query in:inbox", { kind: "search-inbox", query: "invoice" }, { q: "invoice in:inbox -in:trash -in:spam" }],
    // …UNLESS the user's own query already names a place — their operator wins,
    // or in:sent AND in:inbox would return ~nothing ("the email doesn't exist").
    ["search-inbox with user in: operator → no in:inbox append", { kind: "search-inbox", query: "in:sent invoice" }, { q: "in:sent invoice -in:trash -in:spam" }],
    ["search-inbox with label: operator → no in:inbox append", { kind: "search-inbox", query: "label:Clients invoice" }, { q: "label:Clients invoice -in:trash -in:spam" }],
    ["search-all → query -in:trash -in:spam", { kind: "search-all", query: "invoice" }, { q: "invoice -in:trash -in:spam" }],
    // Archived is INDEX-ONLY: thread-level negation Gmail's q cannot express.
    // A live fallback would render a WRONG list — the route must show an
    // unavailable state instead.
    ["archived → index-only, NO live query", { kind: "archived" }, { indexOnly: true }],
  ]
  it.each(cases)("%s", (_name, view, expected) => {
    expect(buildGmailQueryParams(view)).toEqual(expected)
  })
})

describe("removesFromView", () => {
  // The whole matrix. Read this as: "if I do <action> while looking at <view>,
  // does the row leave the list?"
  const matrix: Array<[InboxView, { trash: boolean; archive: boolean; untrash: boolean }]> = [
    // labelIds:INBOX — both actions strip INBOX.
    [{ kind: "inbox" }, { trash: true, archive: true, untrash: false }], // untrash ADDS it here
    // labelIds:TRASH — neither action removes the TRASH label. Nothing leaves.
    [{ kind: "trash" }, { trash: false, archive: false, untrash: true }], // ONLY untrash empties Trash
    // in:starred -in:trash — trash is excluded; archive leaves STARRED intact.
    [{ kind: "label", label: "STARRED" }, { trash: true, archive: false, untrash: false }],
    // A user label survives archive.
    [{ kind: "label", label: "Clients/Acme" }, { trash: true, archive: false, untrash: false }],
    // INBOX-SCOPED search (default): the query requires Inbox membership, so
    // ARCHIVE REMOVES THE ROW — the whole point of Antonio's scope decision.
    [{ kind: "search-inbox", query: "invoice" }, { trash: true, archive: true, untrash: false }],
    // All-mail search: archive doesn't remove it (row stays, chip shows), trash does.
    [{ kind: "search-all", query: "invoice" }, { trash: true, archive: false, untrash: false }],
    // Archived view: a repeat archive is a no-op; trash/untrash/snooze all leave.
    [{ kind: "archived" }, { trash: true, archive: false, untrash: true }],
  ]

  it.each(matrix)("%j", (view, expected) => {
    expect(removesFromView("trash", view)).toBe(expected.trash)
    expect(removesFromView("archive", view)).toBe(expected.archive)
    expect(removesFromView("untrash", view)).toBe(expected.untrash)
  })

  it("a delete never empties a row out of Trash — only a restore does", () => {
    // Trash is where Luca goes to FIND a deleted email. If either of the first two
    // flipped to true, deleting would blank the row he needs to restore; if the
    // third were false, Restore would leave it sitting there looking un-restored.
    expect(removesFromView("trash", { kind: "trash" })).toBe(false)
    expect(removesFromView("archive", { kind: "trash" })).toBe(false)
    expect(removesFromView("untrash", { kind: "trash" })).toBe(true)
  })

  it("a restore is never a hide anywhere else — elsewhere it ADDS a row", () => {
    // A pin, not a hide, is what makes a restored email appear at its destination.
    for (const view of [
      { kind: "inbox" } as const,
      { kind: "label", label: "Label_5" } as const,
      { kind: "search-inbox", query: "invoice" } as const,
      { kind: "search-all", query: "invoice" } as const,
    ]) {
      expect(removesFromView("untrash", view)).toBe(false)
    }
  })
})
