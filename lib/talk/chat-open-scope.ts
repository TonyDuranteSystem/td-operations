/**
 * TD Talk's "open a chat" answer (dev job cf265457, "opening a chat spins every time").
 *
 * `GET /api/team/threads/[id]` is shared by the CRM Team Chat page, the floating chat and TD Talk. Its default answer carries the Threads-panel work
 * (reply counts, follows, Later, read receipts per thread...) that only the CRM page uses, and it asks the database for those one after the other.
 * Measured on the test copy: a 3-message chat and a 520-message chat both took about 1 s to open, so the time is the number of database round trips, not
 * the number of messages. TD Talk asks for `?view=talk` and gets only what its screen uses, with the independent lookups run side by side, and
 * only the newest messages (it already has "Load earlier messages"). Anything without `?view=talk` gets the default answer, unchanged.
 */

export const CHAT_VIEW = 'talk'
/** How many of the newest messages a chat opens with. */
export const CHAT_OPEN_MESSAGES = 60
/** The most one answer ever holds — the same cap as the default answer's window. */
export const CHAT_WINDOW_MAX = 500

/**
 * How many messages to ask for. A refresh asks for at least as many as the screen already shows (a smaller answer would make the older ones disappear),
 * and a link to one message (`?message=`) asks for the whole window because its jump looks for the message in it.
 */
export function chatOpenLimit(shownInWindow: number, jumping: boolean): number {
  if (jumping) return CHAT_WINDOW_MAX
  const have = Number.isFinite(shownInWindow) ? Math.floor(shownInWindow) : 0
  return Math.min(CHAT_WINDOW_MAX, Math.max(CHAT_OPEN_MESSAGES, have))
}

/** Adds the TD Talk view to the chat address. `markReadQuery` is '' or '?mark_read=0' (the read rule decides which). */
export function withChatView(markReadQuery: string, limit: number): string {
  return `${markReadQuery}${markReadQuery ? '&' : '?'}view=${CHAT_VIEW}&limit=${limit}`
}

/** The server's side: is this the TD Talk view, and how many messages. Null = the default answer. */
export function parseChatView(params: URLSearchParams): { limit: number } | null {
  if (params.get('view') !== CHAT_VIEW) return null
  const asked = parseInt(params.get('limit') ?? '', 10)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), CHAT_WINDOW_MAX) : CHAT_OPEN_MESSAGES
  return { limit }
}
