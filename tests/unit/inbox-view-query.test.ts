/**
 * The view→query mapping and the hide predicate that reads it.
 *
 * These two must agree or the Inbox creates optimistic hides its own list query
 * can never confirm — the row hangs until the TTL drops it with no tombstone and
 * pops back minutes later. The params table below is a BYTE-FOR-BYTE lock on what
 * the conversations route sends to Gmail: if someone edits a query string, this
 * test fails and they must revisit `hidesFromCurrentView` in the same breath.
 */
import { describe, it, expect } from "vitest"
import {
  toInboxView,
  viewKey,
  buildGmailQueryParams,
  hidesFromCurrentView,
  type InboxView,
} from "@/lib/inbox/view-query"

describe("toInboxView", () => {
  it("maps the TRASH label to the trash view, not a generic label", () => {
    expect(toInboxView({ label: "TRASH", search: null })).toEqual({ kind: "trash" })
  })

  it("treats INBOX as a label view — it is reachable from the sidebar", () => {
    expect(toInboxView({ label: "INBOX", search: null })).toEqual({ kind: "label", label: "INBOX" })
  })

  it("lets a label WIN over a search — the route's own precedence", () => {
    // A stale string in the search box must not change how we reason about a
    // list the server built from the label alone.
    expect(toInboxView({ label: "STARRED", search: "invoice" })).toEqual({ kind: "label", label: "STARRED" })
  })

  it("uses search only when no label filter is set", () => {
    expect(toInboxView({ label: null, search: "invoice" })).toEqual({ kind: "search", query: "invoice" })
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
      viewKey({ kind: "search", query: "invoice" }, S),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("separates the same view across mailboxes — a different id-universe", () => {
    expect(viewKey({ kind: "inbox" }, S)).not.toBe(viewKey({ kind: "inbox" }, { mailbox: "antonio", channel: "gmail" }))
  })
})

describe("buildGmailQueryParams", () => {
  // Byte-exact: these are the strings the route sends to Gmail today.
  const cases: Array<[string, InboxView, { labelIds?: string; q?: string }]> = [
    ["default inbox → labelIds INBOX", { kind: "inbox" }, { labelIds: "INBOX" }],
    ["trash → labelIds TRASH", { kind: "trash" }, { labelIds: "TRASH" }],
    ["label → in:<lower> -in:trash", { kind: "label", label: "STARRED" }, { q: "in:starred -in:trash" }],
    ["label INBOX → in:inbox -in:trash", { kind: "label", label: "INBOX" }, { q: "in:inbox -in:trash" }],
    ["search → query -in:trash -in:spam", { kind: "search", query: "invoice" }, { q: "invoice -in:trash -in:spam" }],
  ]
  it.each(cases)("%s", (_name, view, expected) => {
    expect(buildGmailQueryParams(view)).toEqual(expected)
  })
})

describe("hidesFromCurrentView", () => {
  // The whole matrix. Read this as: "if I do <action> while looking at <view>,
  // does the row leave the list?"
  const matrix: Array<[InboxView, { trash: boolean; archive: boolean }]> = [
    // labelIds:INBOX — both actions strip INBOX.
    [{ kind: "inbox" }, { trash: true, archive: true }],
    // labelIds:TRASH — neither action removes the TRASH label. Nothing leaves.
    [{ kind: "trash" }, { trash: false, archive: false }],
    // in:starred -in:trash — trash is excluded; archive leaves STARRED intact.
    [{ kind: "label", label: "STARRED" }, { trash: true, archive: false }],
    // in:inbox -in:trash — the label IS the inbox, so archive removes it too.
    [{ kind: "label", label: "INBOX" }, { trash: true, archive: true }],
    // Case-insensitive: the query lowercases the label anyway.
    [{ kind: "label", label: "inbox" }, { trash: true, archive: true }],
    // A user label survives archive.
    [{ kind: "label", label: "Clients/Acme" }, { trash: true, archive: false }],
    // All-mail search: archive doesn't remove it, trash does.
    [{ kind: "search", query: "invoice" }, { trash: true, archive: false }],
  ]

  it.each(matrix)("%j", (view, expected) => {
    expect(hidesFromCurrentView("trash", view)).toBe(expected.trash)
    expect(hidesFromCurrentView("archive", view)).toBe(expected.archive)
  })

  it("never hides anything from Trash — what makes a just-deleted email visible there", () => {
    // Guards Luca's Restore-from-Trash feature: if either of these flips to true,
    // deleting a mail while IN Trash would blank the row he needs to restore.
    expect(hidesFromCurrentView("trash", { kind: "trash" })).toBe(false)
    expect(hidesFromCurrentView("archive", { kind: "trash" })).toBe(false)
  })
})
