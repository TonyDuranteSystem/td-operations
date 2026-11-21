/**
 * The other doors out of a company (dev job beb43385, QA 21 Nov 2026).
 *
 * "Take away portal access" refuses to leave a company with nobody who can open it. Three older doors remove a person's link to a
 * company altogether — Unlink on the company page, the old Contact page "Revoke access", and deleting a contact — and none of them
 * asked. Once some members carry the "no portal access" mark that matters: removing the last person who can still open the company
 * would leave only marked people, and nobody could open it.
 *
 * Narrow on purpose: it only refuses when (a) the person being removed is one of those who can open the company, (b) nobody else
 * who can open it would remain, and (c) at least one person who carries the mark WOULD remain. A company with no marked people is
 * untouched, so the normal roster work (replacing a contact, merging a duplicate) goes on exactly as before.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface RosterLink {
  contact_id: string
  access_revoked_at: string | null
}

/** Pure decision, given every link of the company. */
export function removalLeavesOnlyMarkedPeople(links: RosterLink[], contactId: string): boolean {
  const leaving = links.find(l => l.contact_id === contactId)
  if (!leaving || leaving.access_revoked_at) return false // not linked, or already marked: removing them takes no access away
  const others = links.filter(l => l.contact_id !== contactId)
  const stillOpen = others.filter(l => !l.access_revoked_at)
  const stillMarked = others.filter(l => l.access_revoked_at)
  return stillOpen.length === 0 && stillMarked.length > 0
}

export const REMOVAL_LEAVES_ONLY_MARKED_MESSAGE =
  'This is the last person who can open the company in the portal; everyone else left on it has "no portal access". Give one of them access first, then remove this person.'

/** The same decision read from the database. A failed read answers false, so the roster work is never blocked by a hiccup. */
export async function wouldLeaveOnlyMarkedPeople(accountId: string, contactId: string): Promise<boolean> {
  try {
    // Only while the portal-access switch is on for this company: with it off, the team's Give / Take away buttons are hidden, so
    // "give someone access first" would be advice nobody could follow (Bug Hunter, QA 21 Nov 2026).
    const { memberPortalAccessOn } = await import('@/lib/portal/member-access-switch')
    if (!(await memberPortalAccessOn({ accountId }))) return false
    // portal-access-ok: roster read — the removal guard has to see every link, marked or not
    const { data } = await supabaseAdmin.from('account_contacts').select('contact_id, access_revoked_at').eq('account_id', accountId)
    return removalLeavesOnlyMarkedPeople((data ?? []) as RosterLink[], contactId)
  } catch {
    return false
  }
}

/** Every company where deleting this contact would leave only marked people (empty on any failure). */
export async function companiesLeftWithOnlyMarkedPeople(contactId: string): Promise<string[]> {
  try {
    // portal-access-ok: roster read — which companies this contact is on
    const { data: mine } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId)
    const blocked: string[] = []
    for (const row of (mine ?? []) as Array<{ account_id: string }>) {
      if (await wouldLeaveOnlyMarkedPeople(row.account_id, contactId)) blocked.push(row.account_id)
    }
    return blocked
  } catch {
    return []
  }
}
