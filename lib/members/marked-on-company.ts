/**
 * One question the senders ask before they write to a NAMED person about a company (dev job beb43385, QA round 21 Nov 2026):
 * "does this person's link to this company carry the 'no portal access' mark?"
 *
 * The senders that fan out to a company's whole team already read only the open links. The ones that write to ONE named
 * person (the contact on a service delivery, the signer of an SS-4, the contact a chat message is addressed to) did not,
 * so a member who was unticked in the form — or taken away by the team — still got the company's bell, email and phone
 * alert while the company stayed hidden from their portal. They now ask here first.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * True when the person's link to the company carries the mark. A missing link, a missing id or a failed lookup all read as
 * NOT marked, so a database hiccup never silences a notice that was always sent (the company-wide senders fail the same way).
 */
export async function isMarkedOnCompany(accountId: string | null | undefined, contactId: string | null | undefined): Promise<boolean> {
  if (!accountId || !contactId) return false
  try {
    // portal-access-ok: asks about one named link
    const { data } = await supabaseAdmin
      .from('account_contacts')
      .select('access_revoked_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    return Boolean(data?.access_revoked_at)
  } catch {
    return false
  }
}

/** The contacts of one company that carry the mark (empty on any failure). Used to leave their phones out of a company alert. */
export async function markedContactIds(accountId: string | null | undefined): Promise<Set<string>> {
  if (!accountId) return new Set()
  try {
    // portal-access-ok: asks which links carry the mark
    const { data } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .not('access_revoked_at', 'is', null)
    return new Set((data ?? []).map(r => r.contact_id as string))
  } catch {
    return new Set()
  }
}
