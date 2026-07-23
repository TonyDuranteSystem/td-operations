/**
 * Which queries are allowed to refetch when the user returns to the app.
 *
 * ── WHY THIS IS AN ALLOW-LIST AND NOT AN EXCLUDE-LIST ─────────────────────
 * The obvious implementation is to flip `refetchOnWindowFocus` ON globally and
 * opt the expensive queries OUT. That was tried first (2026-07-22) and it was
 * WRONG — not because the idea is bad, but because the failure is silent and
 * asymmetric:
 *
 *   forget to opt a new CHEAP query IN   → it behaves exactly as it does today
 *   forget to opt a new GMAIL query OUT  → live Gmail calls on every tab-back
 *
 * The second one has already drawn blood: the inbox list issues ~300 live Gmail
 * metadata calls per load, and a bulk action once starved the per-user Gmail
 * quota and blanked the inbox (see docs/systems/inbox.md). The first sweep of
 * Gmail-backed screens missed four of five. A hand-maintained exclude-list is
 * exactly the thing that rots, and it rots toward an outage.
 *
 * So the default stays OFF and this list is the opt-in. Anything not named here
 * keeps today's behaviour. A future query added by someone who never reads this
 * file is safe by construction.
 *
 * ── HOW IT WORKS ───────────────────────────────────────────────────────────
 * React Query's `setQueryDefaults` matches by query-key PREFIX (verified in
 * @tanstack/query-core: getQueryDefaults uses partialMatchKey). So listing
 * 'portal-chat-threads' covers ['portal-chat-threads', accountId, ...].
 *
 * ── WHAT QUALIFIES ─────────────────────────────────────────────────────────
 * A key belongs here only if BOTH hold:
 *   1. its GET handler touches ONLY our database — no Gmail, no Drive, no other
 *      rate-limited third party. Check the GET function specifically: several
 *      routes call Gmail in POST (sending) while GET is pure DB. /api/portal/chat
 *      is exactly that case, and a file-level grep gets it wrong.
 *   2. it shows something that goes stale while you are away — messages, counts,
 *      board columns. Static lookups (templates, document types, help content)
 *      gain nothing from refetching and are deliberately absent.
 */
export const REFRESH_ON_FOCUS_QUERY_KEYS: readonly string[] = [
  // Portal chats — the thread list, the open conversation, and its counters.
  // /api/portal/chat's GET is DB-only; its Gmail call lives in POST (send).
  'portal-chat-threads',
  'portal-chat-messages',
  'portal-chat-issue-counts',
  'portal-chat-whats-new-counts',
  'portal-chat-thread-tasks',

  // Team workspace (internal staff chat).
  'internal-threads',
  'internal-thread-messages',

  // To-Do board / action cards.
  'action-board-columns',
  'open-message-actions',
  'message-actions',

  // Per-client activity summary panels.
  'entity-summary-todos',
  'entity-summary-whatsnew',
  'entity-summary-workflow',
  'thread-whats-new',

  // WhatsApp thread messages (stored in our DB, not fetched live).
  'whatsapp-messages',
]

/**
 * Deliberately NOT in the list — kept as a named record so the next person can
 * see these were considered and excluded on purpose, not simply missed.
 *
 * EXPENSIVE (external API on GET — adding any of these risks a quota incident):
 *   inbox-conversations  ~300 live Gmail metadata calls per load
 *   inbox-messages       live Gmail full-thread fetch
 *   inbox-stats          live Gmail
 *   gmail-labels         live Gmail
 *   client-emails        live Gmail, N+1 (one call per thread)
 *   email-unread         live Gmail
 * These surfaces already stay fresh via Gmail push plus their own polls.
 *
 * POINTLESS (static or lookup data — refetching costs without any benefit):
 *   help-content, document-types, email-templates, topic-templates,
 *   chat-topic-templates, chat-quick-actions, team-client-search,
 *   team-directory, email-links, account-communications, account-files,
 *   correspondence
 */
export const REFRESH_ON_FOCUS_EXCLUDED_FOR_COST: readonly string[] = [
  'inbox-conversations',
  'inbox-messages',
  'inbox-stats',
  'gmail-labels',
  'client-emails',
  'email-unread',
]
