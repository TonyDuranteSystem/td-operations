/**
 * Team Workspace — thread naming rules.
 *
 * Pure so the same rules can be asserted without a DB (R086), and so the
 * server, the panel, the board, and the SQL resolvers can never drift into
 * three different ideas of what a thread is called.
 */

/** Longest a hand-typed thread name may be. */
export const THREAD_TITLE_MAX = 120

/**
 * Normalise a hand-typed thread name for storage.
 *
 * Returns `{ title }` where `title` is the trimmed name, or `null` to CLEAR the
 * name (falling back to the opening message, Slack-style). Returns `{ error }`
 * for input that must be rejected. Newlines are collapsed to spaces — a title
 * is a one-line label, and a pasted paragraph would break every row it renders
 * in.
 */
export function normalizeThreadTitle(input: unknown): { title: string | null } | { error: string } {
  if (input === null) return { title: null }
  if (typeof input !== 'string') return { error: 'Thread name must be text.' }
  const collapsed = input.replace(/\s+/g, ' ').trim()
  if (!collapsed) return { title: null }
  if (collapsed.length > THREAD_TITLE_MAX) {
    return { error: `Thread name must be ${THREAD_TITLE_MAX} characters or fewer.` }
  }
  return { title: collapsed }
}

/**
 * The ONE title resolver, mirrored by the SQL in
 * `20260718-1400-thread-rename-archive.sql`. An explicitly-named thread owns
 * its title; a thread derived from a reply falls back to its opening message
 * (Slack behaviour). A soft-deleted opening message renders a tombstone rather
 * than leaking a deleted body — but a NAMED thread keeps its name even then,
 * which is the whole point of naming it.
 */
export function resolveThreadTitle(args: {
  stateTitle?: string | null
  rootMessage?: string | null
  rootDeleted?: boolean
}): string {
  const named = (args.stateTitle ?? '').trim()
  if (named) return named
  if (args.rootDeleted) return 'Message deleted'
  const body = (args.rootMessage ?? '').trim()
  if (body) return body
  // The literals below MUST match the SQL copies character for character —
  // an earlier version returned '📎 Attachment' here while the SQL returned
  // 'Attachment', so the same thread was labelled two different ways in the
  // panel and on the board. The tests assert the exact strings.
  return 'Attachment'
}

/**
 * Does this thread's state row say anything, or is it just left-over paperwork?
 *
 * A row used to be created for any touch and deleted again to "stay sparse" —
 * which silently reverted renames and un-archived threads. Rows are now kept,
 * so listing must ask whether the row MEANS something instead of whether it
 * EXISTS. Otherwise archiving-then-restoring a stray one-line message, or
 * setting and unsetting a status, would strand it on the board forever as a
 * phantom thread with no replies.
 *
 * Mirrored by the WHERE clause in `20260718-1400-thread-rename-archive.sql`.
 */
export function threadStateIsMeaningful(state: {
  status?: string | null
  assignee_id?: string | null
  title?: string | null
  created_as_thread?: boolean | null
  archived_at?: string | null
} | null | undefined): boolean {
  if (!state) return false
  return !!state.created_as_thread
    || !!(state.title && state.title.trim())
    || !!state.archived_at
    || !!state.assignee_id
    || (!!state.status && state.status !== 'todo')
}

// NOTE: the "can this thread be deleted?" rule deliberately does NOT live here.
// It is enforced inside delete_thread_if_sole_author (migration 20260718-1500),
// where the check and the delete share one transaction — a TypeScript copy could
// only ever be a second, drifting statement of the same rule, and the earlier
// version of exactly that pattern left a window in which a teammate's reply was
// destroyed. The UI offers Delete on the narrower, obviously-safe condition
// "no replies at all"; the server is the authority.
