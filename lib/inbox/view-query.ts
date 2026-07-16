/**
 * The Inbox's view→Gmail-query mapping, and the ONE predicate that depends on it.
 *
 * Why these live together (council, 2026-07-16): the client must decide "does this
 * action remove the row from the list I'm looking at?" — and that answer is a
 * property of the QUERY the server ran, not of the label string. The mapping is
 * NOT uniform (Trash uses `labelIds`; other labels use `in:<x> -in:trash`; search
 * adds `-in:trash -in:spam` over ALL mail; the default uses `labelIds:INBOX` with
 * no `-in:trash` at all), so the predicate cannot be a string-scan. Keeping a
 * second hand-written copy of these rules in the client is exactly what produced
 * two blockers during review. `hidesFromCurrentView` switches over the SAME
 * discriminated union `buildGmailQueryParams` does, so adding a view is a TYPE
 * ERROR until its hide semantics are declared.
 */

/** The Gmail-backed list views the Inbox can show. Precedence matches the route:
 *  a label filter WINS over a search box that still has text in it. */
export type InboxView =
  | { kind: "trash" }
  | { kind: "label"; label: string } // any label except TRASH (incl. 'INBOX', STARRED, SENT, user labels)
  | { kind: "search"; query: string } // search with no label filter → searches ALL mail
  | { kind: "inbox" } // default: no label, no active search

/** The actions that can optimistically REMOVE a row from a list. */
export type HideAction = "trash" | "archive"

/**
 * Normalise the raw UI state into a view. `label` beats `search` — the route's
 * `if (labelFilter) … else if (searchQuery) …` precedence. `search` MUST be the
 * *effective* search (i.e. null unless the search was actually submitted), or the
 * client reasons about a query the server never ran.
 */
export function toInboxView(state: { label: string | null; search: string | null }): InboxView {
  if (state.label) {
    return state.label === "TRASH" ? { kind: "trash" } : { kind: "label", label: state.label }
  }
  if (state.search) return { kind: "search", query: state.search }
  return { kind: "inbox" }
}

/** The id-universe a list was drawn from. Two lists with the same `view` but a
 *  different scope share NO conversation ids, so neither can say anything about
 *  the other's rows. Both dimensions are part of the identity. */
export interface ViewScope {
  /** Which Gmail account: 'support' | 'antonio'. */
  mailbox: string
  /** Which Inbox tab: 'gmail' | 'whatsapp' | … — a WhatsApp payload can never
   *  contain a `gmail:` id, so it must never be able to judge a Gmail override. */
  channel: string
}

/**
 * The origin of a row we CANNOT attribute to any list — e.g. an email opened
 * straight from a deep link, which arrives with no payload behind it.
 *
 * Deliberately a value `viewKey` can never emit, so no payload can ever match it:
 * an override stamped with this APPLIES normally (that is action-derived) but is
 * judged by nobody and retires through the TTL tombstone. Never fall back to a
 * REAL key when the origin is unknown — a real key means some list will happily
 * "confirm" a delete it never witnessed. Unknown must mean unknown.
 */
export const ORIGIN_UNKNOWN = "__origin_unknown__"

/** A stable string key identifying "which exact list is this". An override is
 *  stamped with the key of the list that produced it, and only a payload from
 *  that same list may judge it. */
export function viewKey(view: InboxView, scope: ViewScope): string {
  const prefix = `${scope.channel}:${scope.mailbox}`
  switch (view.kind) {
    case "trash":
      return `${prefix}:trash`
    case "label":
      return `${prefix}:label:${view.label}`
    case "search":
      return `${prefix}:search:${view.query}`
    case "inbox":
      return `${prefix}:inbox`
  }
}

/**
 * The Gmail list params for a view. The conversations route imports this — it is
 * the SINGLE source of the view→query semantics (the route still owns
 * `maxResults` / `pageToken`).
 */
export function buildGmailQueryParams(view: InboxView): { labelIds?: string; q?: string } {
  switch (view.kind) {
    case "trash":
      // Viewing Trash: filter directly by label.
      return { labelIds: "TRASH" }
    case "label":
      // `labelIds` takes the label's ID; `q`'s `in:`/`label:` operators take its
      // NAME. `view.label` is an ID (the sidebar sends `label.id`), so the old
      // `q: in:<id>` matched NOTHING and every custom folder listed zero emails
      // — verified live on support@ 2026-07-16: `in:label_5` → 0 results,
      // `in:_archive` → ~201. It went unnoticed because for SYSTEM labels the id
      // IS the name (INBOX/STARRED/SENT), so only user folders were dead.
      //
      // Filter by ID and keep `-in:trash` as a `q` alongside it (threads.list
      // accepts both; `gmailGet` serializes them). Chosen over resolving id→name
      // because the ID is already this view's identity end-to-end (`viewKey`
      // keys on it), so a name would introduce a second identity for one list —
      // and it needs no labels.list call, no quoting of names with spaces or
      // slashes, and it survives a rename.
      //
      // The old comment claimed `q` was deliberate because the labelIds index
      // lags 30s+ after a modify. Unverified, and irrelevant either way: a view
      // that returns 0 rows 100% of the time is not competing with one that lags
      // — and absorbing that lag is exactly what the override layer above does.
      return { labelIds: view.label, q: "-in:trash" }
    case "search":
      // Search with no label filter searches ALL mail, not just the inbox.
      return { q: `${view.query} -in:trash -in:spam` }
    case "inbox":
      // Default: show INBOX — matches what the Gmail UI shows.
      return { labelIds: "INBOX" }
  }
}

/**
 * Does `action` REMOVE a row from the list `view` is showing?
 *
 * This is the load-bearing rule for optimistic hides: **never create a hide the
 * view's own query cannot confirm.** The reconcile releases a hide only when the
 * thread goes absent from the payload — so if the action doesn't remove it from
 * THIS view, the hide can never release, the TTL drops it with no tombstone, and
 * the row pops back minutes later (the 2026-07-15 archive-in-a-folder bug).
 *
 * Each branch reasons about the query `buildGmailQueryParams` builds for it.
 */
export function hidesFromCurrentView(action: HideAction, view: InboxView): boolean {
  switch (view.kind) {
    case "trash":
      // `labelIds: TRASH`. Trashing an already-trashed thread is a no-op, and
      // archive only strips INBOX — neither removes the TRASH label. So a row
      // NEVER leaves this view by either action.
      // (This is also what makes a just-deleted email visible in Trash.)
      return false
    case "inbox":
      // `labelIds: INBOX`. Both trash and archive strip INBOX → the row leaves.
      return true
    case "label":
      // `labelIds = <this label> + q = -in:trash`.
      // trash  → excluded by `-in:trash` → leaves.
      // archive→ strips ONLY INBOX, and the label survives → the row STAYS…
      //          unless the label IS the inbox, where `in:inbox` no longer matches.
      return action === "trash" ? true : view.label.toUpperCase() === "INBOX"
    case "search":
      // `q = <query> -in:trash -in:spam` over ALL mail.
      // trash  → excluded by `-in:trash` → leaves.
      // archive→ strips only INBOX, which an all-mail search does not require →
      //          the row STAYS. (Known, accepted: a search whose text is itself
      //          `in:inbox` IS inbox-scoped, so archive would remove it and we
      //          skip the hide — the row lingers until the next refetch. Rare,
      //          and it fails in the safe direction: a missing hide, never a
      //          wrongly-hidden email.)
      return action === "trash"
  }
}
