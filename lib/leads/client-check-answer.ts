// Antonio's answer to "is this lead already a client?" (dev job 6fc63c52). Writes the answer, and on "client" links the
// lead to the contact and teaches the contact the email and phone the lead used, so next time it is recognised by itself.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadClientContacts, resolveForLead } from '@/lib/leads/client-check-data'
import { normEmail, samePhone, type ClientContact, type AnswerStatus } from '@/lib/leads/client-context'
import { addContactAliases } from '@/lib/operations/contact-aliases'
import { updateLeadColumnGuarded, isGuardedFailure, type LeadDb } from '@/lib/leads/guarded-update'

export const ANSWERS: AnswerStatus[] = ['client', 'new_lead', 'later']

export interface LearnPlan {
  /** an email to add to contacts.alt_emails, or null when the contact already has it */
  altEmail: string | null
  /** the next free phone column and the number to put in it, or null when the contact already has the number or has no free column */
  phone: { column: 'phone_2' | 'phone_3' | 'phone_4'; value: string } | null
}

/** What the contact should learn from a confirmed lead. Pure. */
export function planLearning(contact: ClientContact, lead: { email: string | null; phone: string | null }): LearnPlan {
  const known = [contact.email, contact.email_2, ...(contact.alt_emails ?? [])].map(normEmail).filter(Boolean)
  const e = normEmail(lead.email)
  const altEmail = e && known.indexOf(e) === -1 ? e : null

  let phone: LearnPlan['phone'] = null
  const p = (lead.phone ?? '').trim()
  const owned = [contact.phone, contact.phone_2, contact.phone_3, contact.phone_4]
  if (p && !owned.some(o => samePhone(p, o))) {
    const free = (['phone_2', 'phone_3', 'phone_4'] as const).find(col => !(contact[col] ?? '').trim())
    if (free) phone = { column: free, value: p }
  }
  return { altEmail, phone }
}

export interface AnswerResult { ok: boolean; status: number; message: string; learned?: { email: boolean; phone: boolean } }

type Db = SupabaseClient

export async function answerClientCheck(db: unknown, args: { leadId: string; contactId: string; answer: AnswerStatus; actor: string }, now: Date = new Date()): Promise<AnswerResult> {
  const sb = db as Db
  if (ANSWERS.indexOf(args.answer) === -1) return { ok: false, status: 400, message: 'The answer must be client, new_lead or later.' }

  const { data: lead } = await sb.from('leads').select('id, full_name, email, phone, existing_client_contact_id').eq('id', args.leadId).maybeSingle()
  if (!lead) return { ok: false, status: 404, message: 'Lead not found.' }

  const contacts = await loadClientContacts(db)
  const contact = contacts.find(c => c.id === args.contactId)
  if (!contact) return { ok: false, status: 400, message: 'That person is not a client of any company, so the question does not apply.' }

  // Reasons are recomputed here, never taken from the browser.
  const verdict = await resolveForLead(db, lead as { id: string; full_name: string | null; email: string | null; phone: string | null; existing_client_contact_id: string | null })
  const reasons = verdict.contactId === contact.id ? verdict.reasons : []

  const { data: existing } = await sb.from('lead_client_checks').select('id').eq('lead_id', args.leadId).eq('contact_id', args.contactId).limit(1)
  const row = { status: args.answer, answered_by: args.actor, answered_at: now.toISOString(), updated_at: now.toISOString() }
  const write = existing && existing.length > 0
    ? await sb.from('lead_client_checks').update(row).eq('id', (existing[0] as { id: string }).id)
    : await sb.from('lead_client_checks').insert({ lead_id: args.leadId, contact_id: args.contactId, reasons, ...row })
  if (write.error) return { ok: false, status: 500, message: 'Could not save your answer — please try again.' }

  if (args.answer === 'later') return { ok: true, status: 200, message: 'Kept open. The automatic move waits for your answer.' }
  if (args.answer === 'new_lead') return { ok: true, status: 200, message: 'Noted. This person is treated as a new lead and the system will not ask again.' }

  // "client": link the lead (only when it is not already linked to someone else), then let the contact learn.
  const marked = (lead as { existing_client_contact_id: string | null }).existing_client_contact_id
  if (!marked) {
    const linked = await updateLeadColumnGuarded(db as unknown as LeadDb, { leadId: args.leadId, column: 'existing_client_contact_id', newValue: args.contactId, expected: null, hasExpected: true })
    if (isGuardedFailure(linked)) return { ok: false, status: linked.reason === 'conflict' ? 409 : 500, message: linked.message }
  }
  const plan = planLearning(contact, lead as { email: string | null; phone: string | null })
  if (plan.altEmail || plan.phone) {
    const up = await addContactAliases(contact.id, plan)
    if (!up.ok) return { ok: true, status: 200, message: 'Linked as an existing client. The new email and phone could not be saved on the contact, add them by hand.', learned: { email: false, phone: false } }
  }
  return { ok: true, status: 200, message: 'Linked as an existing client. The system will not move this lead automatically.', learned: { email: !!plan.altEmail, phone: !!plan.phone } }
}
