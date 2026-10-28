/**
 * "Has the app" — the ONE rule for whether a client already got a push, so an email about the same thing would be a second copy
 * (Antonio 2026-10-28: the client gets the message in the portal; an email only when he does not have the app installed with
 * notifications on). Used by the chat "unread message" nudge (notifyClientOfAdminMessage) and by the stage-change emails
 * (the batched stage notice in the portal digest, and notifyClientOfStageAdvance).
 *
 * Fails toward EMAILING: a lookup error counts as "no app", so a client is never silenced by a database hiccup.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function recipientHasPush(opts: {
  contactId?: string | null
  accountId?: string | null
  /** The notification has ONE person to reach. Account-level subscriptions (legacy rows, never stamped with a person) are trusted only then:
   *  on a multi-member company, one member's subscription must not silence the others (bug-hunter finding, 2026-07-28). */
  singleRecipient: boolean
}): Promise<boolean> {
  const { contactId, accountId, singleRecipient } = opts
  if (contactId) {
    const { count } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
    if (count && count > 0) return true
  }
  if (accountId && singleRecipient) {
    const { count } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (count && count > 0) return true
  }
  return false
}
