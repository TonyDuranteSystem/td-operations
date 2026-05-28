/**
 * Portal Chats conversation-list ordering.
 *
 * A conversation pins to the TOP of the list when it "needs a look":
 *   - it has unread client chat messages (cleared by reading), OR
 *   - it has unhandled "What's New" items — client actions like payments,
 *     signatures, form submissions (cleared ONLY by "Mark handled").
 * Pinned conversations sort newest-first among themselves; everything else
 * sorts newest-first below them.
 *
 * This makes a client action behave like a new message: it bubbles the
 * conversation up and keeps it there until the team marks it handled.
 */

export interface SortableThread {
  account_id: string | null
  contact_id: string | null
  unread_count: number
  last_message_at: string
  /** Manually pinned conversation (staff). Pins sit ABOVE everything. */
  is_pinned?: boolean
}

export interface WhatsNewCounts {
  by_account?: Record<string, number>
  by_contact?: Record<string, number>
}

/** Unhandled What's New count for a thread (account-level first, then contact-level). */
export function whatsNewCountForThread(
  thread: Pick<SortableThread, "account_id" | "contact_id">,
  counts?: WhatsNewCounts | null
): number {
  if (!counts) return 0
  if (thread.account_id) return counts.by_account?.[thread.account_id] ?? 0
  if (thread.contact_id) return counts.by_contact?.[thread.contact_id] ?? 0
  return 0
}

/** True when the conversation should pin to the top (unread OR unhandled What's New). */
export function threadNeedsAttention(
  thread: SortableThread,
  counts?: WhatsNewCounts | null
): boolean {
  return thread.unread_count > 0 || whatsNewCountForThread(thread, counts) > 0
}

/**
 * Returns a NEW array sorted for the conversation list. Does not mutate the input.
 * Tiers (highest first):
 *   1. Manually pinned conversations (is_pinned) — always on top.
 *   2. Needs attention — unread chat OR unhandled What's New.
 *   3. Everything else.
 * Within each tier, newest activity first.
 */
export function sortPortalThreads<T extends SortableThread>(
  threads: T[],
  counts?: WhatsNewCounts | null
): T[] {
  const tier = (t: T): number => {
    if (t.is_pinned) return 2
    if (threadNeedsAttention(t, counts)) return 1
    return 0
  }
  return [...threads].sort((a, b) => {
    const ta = tier(a)
    const tb = tier(b)
    if (ta !== tb) return tb - ta
    return (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "")
  })
}
