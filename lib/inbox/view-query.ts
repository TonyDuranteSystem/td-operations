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
 * two blockers during review. `removesFromView` switches over the SAME
 * discriminated union `buildGmailQueryParams` does, so adding a view is a TYPE
 * ERROR until its hide semantics are declared.
 */

/** Search scope — a decision the user makes with the "Include archived" chip.
 *  'inbox' is the DEFAULT (Antonio, 2026-08-07: "when I search an email I want
 *  to search in inbox and if I want to include the archive I want to have the
 *  option"): archiving noise from an inbox-scoped search makes the row
 *  genuinely leave the results. */
export type SearchScope = "inbox" | "all"

/** Sidebar sentinel for the Archived view (not a real Gmail label id — Gmail
 *  ids never start with '_'; the underscore keeps it out of id-space). */
export const ARCHIVED_VIEW_ID = "_ARCHIVED_"

/** The Gmail-backed list views the Inbox can show. Precedence matches the route:
 *  a label filter WINS over a search box that still has text in it.
 *
 *  The two search SCOPES are two distinct union members ON PURPOSE (architect,
 *  2026-08-07): a `scope` field on one member would compile silently through
 *  every switch below, and an override stamped in one scope could be judged by
 *  the other scope's payload — the foreign-list bug class. Two kinds make every
 *  switch a compile error until each scope's semantics are declared. */
export type InboxView =
  | { kind: "trash" }
  | { kind: "label"; label: string } // any label except TRASH (incl. STARRED, SENT, user labels)
  | { kind: "search-inbox"; query: string } // search restricted to threads in the Inbox (default)
  | { kind: "search-all"; query: string } // search over the whole stored history
  | { kind: "archived" } // out of the Inbox, not trash/spam/snoozed — INDEX-ONLY
  | { kind: "inbox" } // default: no label, no active search

/**
 * The row-level actions whose effect on a list we can derive.
 *
 * NOT all of these remove a row — `untrash` ADDS one to its destination. The name
 * is `RowAction`, not `RowAction`, for exactly that reason: the old name would
 * lead the next session to conclude `untrash` doesn't belong here and to model it
 * somewhere else, which is how a second, drifting copy of these rules gets born.
 */
export type RowAction = "trash" | "archive" | "untrash" | "snooze" | "unsnooze" | "erase"

/**
 * Normalise the raw UI state into a view. `label` beats `search` — the route's
 * `if (labelFilter) … else if (searchQuery) …` precedence. `search` MUST be the
 * *effective* search (i.e. null unless the search was actually submitted), or the
 * client reasons about a query the server never ran.
 */
export function toInboxView(state: {
  label: string | null
  search: string | null
  /** The search chip's scope. Only consulted when `search` is active; callers
   *  that never search (deep links) may omit it. Default 'inbox'. */
  searchScope?: SearchScope
}): InboxView {
  if (state.label) {
    if (state.label === "TRASH") return { kind: "trash" }
    if (state.label === ARCHIVED_VIEW_ID) return { kind: "archived" }
    // The sidebar's Inbox button sends the label id 'INBOX', and "no label" also
    // means the Inbox — the SAME list. Left as two shapes they produce two view
    // keys, and an override stamped with one is invisible to the other: restore
    // an email and it would not appear in the Inbox you are looking at, which is
    // the exact bug the whole subsystem exists to prevent. One list, one identity.
    if (state.label === "INBOX") return { kind: "inbox" }
    return { kind: "label", label: state.label }
  }
  if (state.search) {
    return state.searchScope === "all"
      ? { kind: "search-all", query: state.search }
      : { kind: "search-inbox", query: state.search }
  }
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
    case "search-inbox":
      // Scope is part of the list's IDENTITY: the same query text in the other
      // scope is a DIFFERENT list and must never judge this one's overrides.
      return `${prefix}:search:inbox:${view.query}`
    case "search-all":
      return `${prefix}:search:all:${view.query}`
    case "archived":
      return `${prefix}:archived`
    case "inbox":
      return `${prefix}:inbox`
  }
}

/**
 * The Gmail list params for a view. The conversations route imports this — it is
 * the SINGLE source of the view→query semantics (the route still owns
 * `maxResults` / `pageToken`).
 */
/** True when the user's own query already pins a place (`in:sent`, `label:x`,
 *  `is:...` is NOT a place) — appending our default `in:inbox` on top of it
 *  would AND two scopes into ~zero results ("the email doesn't exist" —
 *  bug-hunter, 2026-08-07). The user's operator wins. */
export function queryCarriesScopeOperator(query: string): boolean {
  return /(^|\s)(in|label):/i.test(query)
}

/**
 * True when the search box content is a plain-word query the local index can
 * answer. Gmail operator syntax (from:, has:attachment, in:sent, …) keeps the
 * full live-Gmail behavior. Lives HERE (client-safe, dependency-free) because
 * the browser needs the same judgment for LIVE-as-you-type search: plain words
 * auto-filter on a debounce (a cheap DB query), operator queries wait for
 * Enter — firing live Gmail per keystroke is the 2026-08-02 quota incident.
 * The server query layer re-exports it, so both sides share one definition.
 */
export function isInstantSearchQuery(q: string): boolean {
  const trimmed = q.trim()
  if (!trimmed) return false
  if (/[{}()]/.test(trimmed)) return false // grouped Gmail syntax
  return !/(^|\s)-?(from|to|cc|bcc|subject|has|in|is|label|filename|after|before|newer_than|older_than|deliveredto|list|rfc822msgid|larger|smaller|category):/i.test(
    trimmed
  )
}

export function buildGmailQueryParams(view: InboxView): { labelIds?: string; q?: string; indexOnly?: true } {
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
    case "search-inbox":
      // Inbox-scoped search (the default). When the user's own query already
      // names a place (in:sent, label:x), THEIR operator wins — appending
      // in:inbox would contradict it into zero results.
      return queryCarriesScopeOperator(view.query)
        ? { q: `${view.query} -in:trash -in:spam` }
        : { q: `${view.query} in:inbox -in:trash -in:spam` }
    case "search-all":
      // Explicit all-mail search (the "Include archived" chip).
      return { q: `${view.query} -in:trash -in:spam` }
    case "archived":
      // INDEX-ONLY. "Archived" is a thread-level negation (no message of the
      // thread carries INBOX) that Gmail's query language cannot express — any
      // live q here would render a WRONG list. The route must never fall back
      // to live Gmail for this view; it shows an explicit unavailable state
      // instead (council, 2026-08-07).
      return { indexOnly: true }
    case "inbox":
      // Default: show INBOX — matches what the Gmail UI shows.
      return { labelIds: "INBOX" }
  }
}

/**
 * Does `action` REMOVE a row from the list `view` is showing?
 *
 * The load-bearing rule for optimistic hides: **never create a hide the view's
 * own query cannot confirm.** A hide releases only when the thread goes absent
 * from that view's payload — so if the action doesn't remove it from THIS view,
 * the hide can never be witnessed, and it lingers to the TTL (the 2026-07-15
 * archive-in-a-folder bug).
 *
 * BOTH dimensions are exhaustive on purpose. The view switch makes adding a view
 * a type error; the per-view `Record<RowAction, boolean>` makes adding an ACTION
 * a type error in every branch. That second half was missing when `untrash` was
 * added, and nothing complained: the trash branch's `return false` silently meant
 * "Restore leaves the row sitting in Trash", and the label/search branches were
 * right only by luck (council, 2026-07-16). An action's removal semantics are a
 * DECISION — the compiler now demands you make it four times.
 *
 * Each branch reasons about the query `buildGmailQueryParams` builds for it.
 */
export function removesFromView(action: RowAction, view: InboxView): boolean {
  switch (view.kind) {
    case "trash":
      // `labelIds: TRASH`.
      return {
        // Trashing an already-trashed thread is a no-op — the row stays.
        trash: false,
        // Archive strips only INBOX; the TRASH label survives — the row stays.
        // (This is what makes a just-deleted email visible in Trash.)
        archive: false,
        // Untrash REMOVES the TRASH label → the row leaves this list. This is
        // the one action that empties a row out of Trash.
        untrash: true,
        // Snoozing strips INBOX only; TRASH (if any) survives → stays. (The UI
        // doesn't offer snooze in Trash, but the semantics must still be true.)
        snooze: false,
        // Unsnooze ADDs INBOX — never removes from Trash.
        unsnooze: false,
        // Erase ("delete forever") destroys our stored copy AND its index row —
        // the row is gone from every list, including this one. Trash is the ONLY
        // view the action is offered in, so this entry is the one that matters:
        // without it the row sat in Trash for ever after being "deleted
        // permanently" (bug-hunter + senior-engineer, 2026-08-04).
        erase: true,
      }[action]
    case "inbox":
      // `labelIds: INBOX`.
      return {
        trash: true, // strips INBOX → leaves
        archive: true, // strips INBOX → leaves
        // Untrash ADDS the row back to the Inbox — the opposite of a removal.
        // A pin, not a hide, is what makes it appear (see the reconcile).
        untrash: false,
        snooze: true, // strips INBOX → leaves (this is the snooze mechanism)
        unsnooze: false, // ADDs INBOX — an appearance (pin), never a removal
        erase: true, // the index row is deleted → gone from every list
      }[action]
    case "label":
      // `labelIds = <this label> + q = -in:trash`.
      return {
        trash: true, // excluded by `-in:trash` → leaves
        // Archive strips ONLY INBOX and the label survives → the row STAYS.
        // (No INBOX special-case here any more: `toInboxView` collapses the
        // 'INBOX' label into `{kind:'inbox'}`, so this branch is never the inbox.)
        archive: false,
        // Untrash re-admits it to `-in:trash` — it APPEARS here if it carries
        // this label (folders survive trashing). Never a removal.
        untrash: false,
        // Snooze strips only INBOX; a folder label survives → the row STAYS
        // (same shape as archive). In the SNOOZED folder itself the row gains
        // the label — an appearance, not a removal.
        snooze: false,
        // Unsnooze removes the row ONLY from the Snoozed folder — but this
        // static branch can't tell that label apart from any other, and a
        // wrong `true` here is the unconfirmable-hide bug (2026-07-15).
        // Accepted: in the Snoozed view the woken row lingers until the next
        // refetch — the safe direction (council SE + bug-hunter, 2026-07-28).
        unsnooze: false,
        erase: true, // the index row is deleted → gone from every list
      }[action]
    case "search-inbox":
      // Inbox-scoped search: the query REQUIRES Inbox membership, so anything
      // that strips INBOX removes the row — this is the semantics Antonio asked
      // for by name ("archive noise from search and watch it leave").
      return {
        trash: true, // strips INBOX (and adds TRASH) → leaves
        archive: true, // strips INBOX → leaves
        untrash: false, // re-appears (pin), never a removal
        snooze: true, // strips INBOX → leaves
        unsnooze: false, // ADDs INBOX — an appearance, not a removal
        erase: true, // the index row is deleted → gone from every list
      }[action]
    case "search-all":
      // `q = <query> -in:trash -in:spam` over ALL mail.
      return {
        trash: true, // excluded by `-in:trash` → leaves
        // Archive strips only INBOX, which an all-mail search doesn't require →
        // the row STAYS (and renders its payload-derived "Archived" chip).
        // (Known, accepted: a query whose own text is `in:inbox` is effectively
        // inbox-scoped; we skip the hide — safe direction, a missing hide.)
        archive: false,
        untrash: false, // re-admitted to the search, not removed
        snooze: false, // all-mail search doesn't require INBOX → stays
        unsnooze: false,
        erase: true, // the index row is deleted → gone from every list
      }[action]
    case "archived":
      // Index predicate: NO message carries INBOX, thread not trash/spam/snoozed.
      return {
        trash: true, // gains TRASH → leaves Archived
        archive: false, // already archived — a repeat archive is a no-op
        // Untrash / unsnooze ADD the thread back to the Inbox → it leaves this
        // view, but as an appearance elsewhere; the refetch confirms. A hide
        // here could not be witnessed by any OTHER view, so keep the safe
        // shape: hide only what THIS view's own refetch will confirm absent.
        untrash: true,
        snooze: true, // snoozed threads are excluded from Archived → leaves
        unsnooze: true, // regains INBOX → excluded from Archived → leaves
        erase: true, // the index row is deleted → gone from every list
      }[action]
  }
}
