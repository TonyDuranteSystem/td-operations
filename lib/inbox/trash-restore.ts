/**
 * Undo-a-delete: putting back what trashing strips.
 *
 * Trashing a thread removes UNREAD / STARRED / IMPORTANT along with INBOX (see
 * the `trash` branch of app/api/inbox/email-actions). Untrashing only re-adds
 * INBOX, so an unread or starred email that was deleted and then restored came
 * back read and unstarred — the state was simply gone (Antonio, 2026-07-14).
 *
 * Gmail cannot tell us what those labels WERE after the fact, so we capture them
 * at trash time and hand them back to the client, which returns them with the
 * Undo call. We deliberately do NOT "fix" this by leaving UNREAD on trashed
 * threads: the sidebar badges Trash with `threadsUnread`, so that would start
 * showing an unread count on Trash — a global change nobody asked for.
 */

/** The labels trashing strips that an Undo should put back. */
export const RESTORABLE_LABELS = ['UNREAD', 'STARRED', 'IMPORTANT'] as const

export interface RestoreEntry {
  /** Gmail message id. */
  id: string
  /** Subset of RESTORABLE_LABELS that this message had before it was trashed. */
  labels: string[]
}

const RESTORABLE = new Set<string>(RESTORABLE_LABELS)

/**
 * Snapshot the restorable labels of a thread's messages, taken BEFORE trashing.
 * Messages with none of them are omitted — there is nothing to put back.
 */
export function captureRestorableLabels(
  messages: Array<{ id?: string; labelIds?: string[] }> | undefined | null,
): RestoreEntry[] {
  const out: RestoreEntry[] = []
  for (const m of messages || []) {
    if (!m?.id) continue
    const labels = (m.labelIds || []).filter((l) => RESTORABLE.has(l))
    if (labels.length > 0) out.push({ id: m.id, labels })
  }
  return out
}

/**
 * Validate a restore payload coming back from the browser on Undo.
 *
 * The client round-trips this, so treat it as untrusted input: keep only string
 * ids and only labels from the allow-list, so an Undo can never be used to slap
 * an arbitrary label onto a message. (The mailbox itself is already gated by
 * checkMailboxAccess upstream.)
 */
export function sanitizeRestorePayload(raw: unknown): RestoreEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RestoreEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, labels } = item as { id?: unknown; labels?: unknown }
    if (typeof id !== 'string' || !id) continue
    if (!Array.isArray(labels)) continue
    const clean = labels.filter((l): l is string => typeof l === 'string' && RESTORABLE.has(l))
    if (clean.length > 0) out.push({ id, labels: clean })
  }
  return out
}
