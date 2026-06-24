/**
 * Per-company portal chat scoping — the single source of truth for WHICH
 * messages belong in a client's currently-viewed thread.
 *
 * Why this exists (2026-06-24): multi-company clients previously saw ONE merged
 * thread (the hook threaded by contact_id only). When they switch companies in
 * the sidebar, the chat must now switch too. Crucially, this is a PRIVACY
 * boundary, not just a filter:
 *
 *   - A company (account) thread is shared by EVERYONE linked to that account —
 *     every member contact AND any chat-capable teammate. So a company thread
 *     must show ONLY messages tagged to that account_id. Never a contact's
 *     personal (account_id IS NULL) messages, or other members would see them.
 *   - A contact's personal/NULL messages may ride along in a company view ONLY
 *     when that account is SOLE-OWNED by the viewer (exactly one linked contact
 *     == the viewer). That is the only case where no other human can see the
 *     thread. This is decided STRUCTURALLY (linked-contact count), NOT from the
 *     free-text `account_contacts.role` column — role data is unreliable
 *     (`owner`/`Owner`/`Member`/`member`/`Sole Member`/null, and 61 MMLLC
 *     accounts carry an `owner`-role contact), so keying on it would leak.
 *
 * The decision is ALWAYS made server-side (the GET route re-derives it with
 * supabaseAdmin); the client receives only the resulting booleans for its
 * realtime filter, never the authority to widen its own scope.
 */

export type ClientChatScope = 'company' | 'personal'

/** Resolved query plan for a client's scoped thread. */
export type ChatQueryPlan =
  | { mode: 'account'; accountId: string }
  | { mode: 'account_plus_personal'; accountId: string; contactId: string }
  | { mode: 'personal_only'; contactId: string }

/**
 * Leak-proof rule: a contact's personal (account_id IS NULL) messages may be
 * shown inside a company thread ONLY when that account is sole-owned by this
 * one viewer — exactly one linked contact, and it is the viewer. Any second
 * linked contact (member) or the account being multi-member ⇒ false ⇒ never
 * leak personal messages into a thread someone else can open.
 */
export function mayIncludePersonalNull(opts: {
  linkedContactCount: number
  viewerIsSoleLinkedContact: boolean
}): boolean {
  return opts.linkedContactCount === 1 && opts.viewerIsSoleLinkedContact === true
}

/**
 * Build the message-query plan for a client request. Returns null when the
 * inputs are insufficient (caller should 400).
 */
export function buildChatQueryPlan(opts: {
  scope: ClientChatScope
  accountId: string | null
  contactId: string | null
  includePersonalNull: boolean
}): ChatQueryPlan | null {
  if (opts.scope === 'company') {
    if (!opts.accountId) return null
    if (opts.includePersonalNull && opts.contactId) {
      return { mode: 'account_plus_personal', accountId: opts.accountId, contactId: opts.contactId }
    }
    return { mode: 'account', accountId: opts.accountId }
  }
  // personal / formation (no account): only the viewer's own untagged messages.
  if (!opts.contactId) return null
  return { mode: 'personal_only', contactId: opts.contactId }
}

/**
 * Does a message belong in this plan's view? Used by the realtime handler to
 * drop messages that arrive on a broad (contact_id) subscription but belong to
 * a different company. Mirrors the server query EXACTLY.
 */
export function messageVisibleInPlan(
  plan: ChatQueryPlan,
  msg: { account_id: string | null; contact_id: string | null },
): boolean {
  switch (plan.mode) {
    case 'account':
      return msg.account_id === plan.accountId
    case 'account_plus_personal':
      return (
        msg.account_id === plan.accountId ||
        (msg.account_id == null && msg.contact_id === plan.contactId)
      )
    case 'personal_only':
      return msg.account_id == null && msg.contact_id === plan.contactId
  }
}
