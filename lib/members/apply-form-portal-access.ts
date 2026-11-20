/**
 * What the portal-access tick in the formation / onboarding wizard does to a member's link to the company
 * (dev job beb43385, delivery B).
 *
 * The tick never touches membership: the contact, the `members` ownership row (legal fact — Operating Agreement, SS-4,
 * ownership list) and the account_contacts link are written exactly as before. The tick only decides whether the link
 * carries the "no portal access" mark (account_contacts.access_revoked_at):
 *
 *   ticked false  → put the mark on the link (no portal access for this company; the person's other companies and their
 *                   login, if they have one, are untouched — the mark hides the COMPANY, never the login)
 *   ticked true   → take the mark off ONLY if the form put it there. A mark with a person in access_revoked_by was put
 *                   there by the team and the form never lifts it ("only the team changes it after the form")
 *   ticked null   → the form had no tick (an older form, or the switch was off): nothing changes, as before
 *
 * The owner (the person filling the form) is never marked. Errors come back as text for the caller's step list; the
 * ownership row has already been written by then, so a failure here never loses a legal fact.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export type FormAccessAction = 'mark' | 'lift' | 'none'

export function decideFormAccess(ticked: boolean | null | undefined): FormAccessAction {
  if (ticked === false) return 'mark'
  if (ticked === true) return 'lift'
  return 'none'
}

/** The narrow slice of the database client this helper uses, so tests can inject a fake. */
interface LinkQuery extends PromiseLike<{ error: { message: string } | null }> {
  eq: (col: string, val: string) => LinkQuery
  is: (col: string, val: null) => LinkQuery
  not: (col: string, op: string, val: null) => LinkQuery
}
export interface LinkDb {
  from: (table: string) => { update: (values: Record<string, unknown>) => LinkQuery }
}

export interface ApplyFormAccessResult {
  action: FormAccessAction
  /** Set when the database refused the change. */
  error?: string
}

export async function applyFormPortalAccess(opts: {
  accountId: string
  contactId: string
  /** The person filling the form. Never marked. */
  ownerContactId?: string | null
  ticked: boolean | null | undefined
  now?: string
  db?: LinkDb
}): Promise<ApplyFormAccessResult> {
  const action = decideFormAccess(opts.ticked)
  if (action === 'none') return { action }
  if (opts.ownerContactId && opts.contactId === opts.ownerContactId) return { action: 'none' }

  const db = opts.db ?? (supabaseAdmin as unknown as LinkDb)
  // portal-access-ok: write
  const base = db.from('account_contacts')
  if (action === 'mark') {
    const { error } = await base
      .update({ access_revoked_at: opts.now ?? new Date().toISOString() })
      .eq('account_id', opts.accountId)
      .eq('contact_id', opts.contactId)
      .is('access_revoked_at', null) // keep the time of an earlier mark
    return error ? { action, error: error.message } : { action }
  }
  // lift — only a mark the form itself put there (nobody in access_revoked_by)
  const { error } = await base
    .update({ access_revoked_at: null })
    .eq('account_id', opts.accountId)
    .eq('contact_id', opts.contactId)
    .not('access_revoked_at', 'is', null)
    .is('access_revoked_by', null)
  return error ? { action, error: error.message } : { action }
}
