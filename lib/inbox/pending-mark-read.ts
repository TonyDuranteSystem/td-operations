/**
 * Serializer between the open-time auto-mark-read and the header's
 * "Mark unread" button.
 *
 * Opening a conversation fires a background "mark read" against Gmail
 * (message-thread.tsx). That call is SLOW — a thread fetch plus one modify
 * per message — while the header's "mark unread" is a single thread modify.
 * Click "Mark unread" while the auto-read is still in flight and the writes
 * land out of order: the stale auto-read finishes LAST and silently undoes
 * the user's choice. That is exactly Antonio's "it only works after I go
 * back and reopen" (production QA, 2026-08-05) — on a reopen the auto-read
 * has long settled, so the click sticks.
 *
 * The thread view records its in-flight call here; the header action awaits
 * it before writing. Module-level on purpose: the two components sit in
 * different trees (the thread view is also mounted by portal-chats), and a
 * browser tab is a single session — no cross-request state to worry about.
 */

const pending = new Map<string, Promise<void>>()

/** Record an in-flight open-time mark-read for this conversation. */
export function trackOpenMarkRead(conversationId: string, call: Promise<unknown>): void {
  const settled = call
    .then(() => undefined)
    // A failed auto-read must never wedge the header button — settle anyway.
    .catch(() => undefined)
  const entry: Promise<void> = settled.finally(() => {
    // Only clear our own entry: a fast re-open may have replaced it.
    if (pending.get(conversationId) === entry) pending.delete(conversationId)
  })
  pending.set(conversationId, entry)
}

/**
 * Resolves when any in-flight open-time mark-read for this conversation has
 * settled. Resolves immediately when there is none.
 */
export function openMarkReadSettled(conversationId: string): Promise<void> {
  return pending.get(conversationId) ?? Promise.resolve()
}

/** Test hook — the map is module state. */
export function _clearPendingMarkRead(): void {
  pending.clear()
}
