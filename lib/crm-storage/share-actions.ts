/**
 * The two server-side "share an existing CRM Storage file" calls. Modeled
 * directly on lib/captures/share-actions.ts (the proven Team Chat / Portal
 * Chat send pattern), with one deliberate difference: no `resend` flag.
 *
 * Captures are one-shot (a screenshot gets claimed by its first destination,
 * via a `destination` column, and a later re-share is an explicit opt-in).
 * crm_storage_files has no such column and no such semantics — a stored
 * document (an invoice, a signed lease) is a standing library item that may
 * legitimately be sent to the same or a different chat more than once, so
 * there is nothing to "claim" and no resend flag is needed. The routes
 * behind these calls still validate the recipient fresh on every call and
 * still guard against a genuine double-click (see each route's own header).
 */

export async function sendStorageFileToTeamChat(fileId: string, threadId: string): Promise<void> {
  const res = await fetch(`/api/crm-storage/files/${fileId}/share-team-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || "Could not send to team chat. Please try again.")
  }
}

export async function sendStorageFileToPortalChat(
  fileId: string,
  target: { contact_id: string | null; account_id: string | null },
): Promise<void> {
  const res = await fetch(`/api/crm-storage/files/${fileId}/share-portal-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || "Could not send it to the client. Please try again.")
  }
}
