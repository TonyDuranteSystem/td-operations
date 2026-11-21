/**
 * "Has the app" — whether a push already reached a client, so an email about the same thing would be a second copy
 * (Antonio 2026-10-28: the client gets the message in the portal; an email only when he does not have the app installed with
 * notifications on). Shared by the chat "unread message" nudge (notifyClientOfAdminMessage) and the stage-change emails (the
 * batched stage notice in the portal digest, and notifyClientOfStageAdvance).
 *
 * The rule is always: the email is skipped only when the SAME PERSON the email would go to has a device the push goes to.
 *  - a push addressed to a PERSON reaches every device stamped with that person (push_subscriptions.contact_id);
 *  - a push addressed to a COMPANY reaches every device stamped with that company (push_subscriptions.account_id) — which includes a
 *    teammate's device (contact_id null) and every member's device, so "some device of the company exists" says nothing about whether
 *    the person who gets the company's email was reached (bug-hunter finding, 2026-10-28; 239 of 301 open production cases are company-only).
 *
 * Fails toward EMAILING: a lookup error counts as "no app", so a client is never silenced by a database hiccup.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

/** A device stamped with this person: a push addressed to the person reaches it. */
export async function personHasPush(contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false
  const { count } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
  return !!count && count > 0
}

/** A device of this person stamped with this company: a push addressed to the company reaches it. */
export async function personHasCompanyPush(contactId: string | null | undefined, accountId: string | null | undefined): Promise<boolean> {
  if (!contactId || !accountId) return false
  const { count } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
  return !!count && count > 0
}

/**
 * The person the portal digest emails for a COMPANY-only notice: the company's one email address (accounts.communication_email, else the
 * primary owner — getCompanyEmail), mapped back to the linked contact who owns that address. Null when the address belongs to nobody
 * linked (then no person can be shown to have the app).
 */
export async function companyEmailRecipientContactId(accountId: string): Promise<string | null> {
  const { getCompanyEmail } = await import('@/lib/portal/queries')
  const email = await getCompanyEmail(accountId)
  if (!email) return null
  const wanted = email.trim().toLowerCase()
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id, contacts(email)')
    .is('access_revoked_at', null)
    .eq('account_id', accountId)
  for (const l of (links ?? []) as Array<{ contact_id: string | null; contacts: { email: string | null } | null }>) {
    if (l.contact_id && (l.contacts?.email ?? '').trim().toLowerCase() === wanted) return l.contact_id
  }
  return null
}

/**
 * Step 8 of advanceServiceDelivery: the bell notice for a stage move is emailed later by the portal digest. Is that email redundant?
 *  - the notice is addressed to a PERSON (the case has a contact): the digest emails that person -> true when they have a device;
 *  - the notice is addressed to a COMPANY only: the digest emails the company's one address -> true only when the person who owns that
 *    address has a device stamped with this company (so the company push reached them).
 * Never throws: any failure answers false (the email goes out as before).
 */
export async function stageNoticeRecipientHasApp(opts: { contactId?: string | null; accountId?: string | null }): Promise<boolean> {
  try {
    if (opts.contactId) return await personHasPush(opts.contactId)
    if (opts.accountId) {
      const holder = await companyEmailRecipientContactId(opts.accountId)
      return holder ? await personHasCompanyPush(holder, opts.accountId) : false
    }
    return false
  } catch {
    return false
  }
}

/**
 * The per-recipient rule of the chat "unread message" nudge (notifyClientOfAdminMessage): the person's own devices; a company-level device
 * only when this notification has ONE person to reach (a multi-member company must never be silenced by one member's device) and the device is
 * not ANOTHER team login's (a team login's alerts reach that login, never the person who gets the email). A recipient who IS a team login
 * (`ownLoginId`) keeps credit for their own device.
 */
export async function recipientHasPush(opts: {
  contactId?: string | null
  accountId?: string | null
  /** The notification has ONE person to reach. Account-level subscriptions (legacy rows, never stamped with a person) are trusted only then. */
  singleRecipient: boolean
  /** The recipient is a team login: its own sign-in id. Its own device counts as theirs. */
  ownLoginId?: string | null
}): Promise<boolean> {
  const { contactId, accountId, singleRecipient, ownLoginId } = opts
  if (contactId && (await personHasPush(contactId))) return true
  if (accountId && singleRecipient) {
    // A device stamped with the company only counts when it is NOT another team login's device: a team login's alerts reach that login, never
    // the person the email goes to (team-login device bug, dev job e59dd470). Every login of the company counts here — removed or switched off
    // too, because their devices stay registered — except the recipient's own. Any lookup error answers "no app": the email goes out.
    const { data: devices, error: devicesError } = await supabaseAdmin
      .from('push_subscriptions')
      .select('user_id')
      .eq('account_id', accountId)
    if (devicesError || !devices || devices.length === 0) return false
    const { data: logins, error: loginsError } = await supabaseAdmin
      .from('portal_team_members')
      .select('auth_user_id')
      .eq('account_id', accountId)
    if (loginsError) return false
    const otherLoginIds = new Set((logins ?? []).map((l) => l.auth_user_id).filter((id) => id !== ownLoginId))
    return devices.some((d) => !d.user_id || !otherLoginIds.has(d.user_id))
  }
  return false
}
