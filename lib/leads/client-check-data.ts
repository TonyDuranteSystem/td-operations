// Gathers the CRM facts the client-or-lead question needs and runs the resolver (dev job 6fc63c52).
// Read through the service client AFTER the caller has checked the person is staff. The new table is read through the
// untyped client; before its migration has been run every read returns "no answers" and the question simply never opens.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveClientVerdict, digitsOnly, type ClientAnswer, type ClientContact, type ClientEvidence, type ClientVerdict, type LeadIdentity, type AnswerStatus,
} from '@/lib/leads/client-context'

type Db = SupabaseClient
const asDb = (db: unknown) => db as Db

interface ContactRow {
  id: string
  full_name: string | null
  email: string | null
  email_2: string | null
  alt_emails: string[] | null
  phone: string | null
  phone_2: string | null
  phone_3: string | null
  phone_4: string | null
  account_contacts: { account_id: string; accounts: { company_name: string | null; status: string | null } | null }[]
}

/** Every contact that belongs to at least one company, with its companies. A few hundred rows: matched in memory. */
export async function loadClientContacts(db: unknown): Promise<ClientContact[]> {
  const rows: ContactRow[] = []
  // PostgREST returns at most 1000 rows per request whatever range is asked: page through, in a stable order.
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await asDb(db)
      .from('contacts')
      .select('id, full_name, email, email_2, alt_emails, phone, phone_2, phone_3, phone_4, account_contacts!inner(account_id, accounts(company_name, status))')
      .order('id')
      .range(from, from + 999)
    if (error) return from === 0 ? [] : rows.map(toClientContact)
    const page = (data ?? []) as unknown as ContactRow[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows.map(toClientContact)
}

function toClientContact(c: ContactRow): ClientContact {
  return {
    id: c.id, full_name: c.full_name, email: c.email, email_2: c.email_2, alt_emails: c.alt_emails,
    phone: c.phone, phone_2: c.phone_2, phone_3: c.phone_3, phone_4: c.phone_4,
    companies: (c.account_contacts ?? []).filter(a => a.accounts && a.accounts.company_name).map(a => ({ name: a.accounts?.company_name as string, status: a.accounts?.status ?? null })),
  }
}

/** Answers Antonio already gave, for one lead or for many (the table). Empty before the migration. */
export async function loadAnswers(db: unknown, leadIds: string[]): Promise<Map<string, ClientAnswer[]>> {
  const out = new Map<string, ClientAnswer[]>()
  if (leadIds.length === 0) return out
  const { data, error } = await asDb(db).from('lead_client_checks').select('lead_id, contact_id, status').in('lead_id', leadIds)
  if (error) return out
  for (const r of (data ?? []) as { lead_id: string; contact_id: string; status: string }[]) {
    const list = out.get(r.lead_id) ?? []
    list.push({ contactId: r.contact_id, status: r.status as AnswerStatus })
    out.set(r.lead_id, list)
  }
  return out
}

/** What the lead's call recordings and WhatsApp chats say (names on the call, call notes, chat numbers). */
export async function loadEvidence(db: unknown, leadId: string, leadPhone: string | null): Promise<ClientEvidence> {
  const sb = asDb(db)
  const { data: calls } = await sb.from('call_summaries').select('attendees, notes').eq('lead_id', leadId).limit(20)
  const attendees: { name?: string | null; email?: string | null }[] = []
  const notes: string[] = []
  for (const c of (calls ?? []) as { attendees: unknown; notes: string | null }[]) {
    if (Array.isArray(c.attendees)) {
      for (const a of c.attendees as { name?: string | null; email?: string | null }[]) if (a && typeof a === 'object') attendees.push({ name: a.name ?? null, email: a.email ?? null })
    }
    if (c.notes) notes.push(c.notes.slice(0, 6000))
  }
  const digits = leadPhone ? digitsOnly(leadPhone) : ''
  const jids = digits.length >= 7 ? [`${digits}@c.us`, digits] : []
  const filter = jids.length ? `lead_id.eq.${leadId},external_group_id.in.(${jids.join(',')})` : `lead_id.eq.${leadId}`
  const { data: chats } = await sb.from('messaging_groups').select('external_group_id, group_type').or(filter)
  const chatPhones = ((chats ?? []) as { external_group_id: string | null; group_type: string | null }[])
    .filter(g => g.group_type !== 'support_group' && !(g.external_group_id ?? '').endsWith('@g.us'))
    .map(g => digitsOnly(g.external_group_id))
    .filter(d => d.length >= 7)
  return { attendees, notesText: notes.join('\n'), chatPhones }
}

export interface LeadClientVerdict extends ClientVerdict { leadId: string }

/** The full verdict for ONE lead: every CRM source, including recordings and chats. */
export async function resolveForLead(db: unknown, lead: LeadIdentity & { id: string; existing_client_contact_id?: string | null }): Promise<LeadClientVerdict> {
  const [contacts, answersMap, evidence] = await Promise.all([
    loadClientContacts(db),
    loadAnswers(db, [lead.id]),
    loadEvidence(db, lead.id, lead.phone),
  ])
  const v = resolveClientVerdict({ lead, contacts, evidence, answers: answersMap.get(lead.id) ?? [], markedContactId: lead.existing_client_contact_id ?? null })
  return { ...v, leadId: lead.id }
}

/**
 * Verdicts for MANY leads (the table), from the cheap signals only (email, phone, name) so one fetch covers the page.
 * Same resolver as the window; the window may find more because it also reads recordings and chats.
 */
export function resolveForLeads(
  leads: (LeadIdentity & { id: string; existing_client_contact_id?: string | null })[],
  contacts: ClientContact[],
  answers: Map<string, ClientAnswer[]>,
): Map<string, ClientVerdict> {
  const out = new Map<string, ClientVerdict>()
  for (const l of leads) out.set(l.id, resolveClientVerdict({ lead: l, contacts, answers: answers.get(l.id) ?? [], markedContactId: l.existing_client_contact_id ?? null }))
  return out
}

/** Record that the system is waiting for an answer (the automatic move met a "maybe"). Never changes an answer already given. */
export async function ensureOpenCheck(db: unknown, leadId: string, verdict: ClientVerdict): Promise<void> {
  if (verdict.verdict !== 'maybe' || !verdict.contactId) return
  const sb = asDb(db)
  const { data } = await sb.from('lead_client_checks').select('id').eq('lead_id', leadId).eq('contact_id', verdict.contactId).limit(1)
  if (data && data.length > 0) return
  await sb.from('lead_client_checks').insert({ lead_id: leadId, contact_id: verdict.contactId, status: 'open', reasons: verdict.reasons })
}
