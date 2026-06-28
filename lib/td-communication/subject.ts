/**
 * TD Communication — polymorphic subject resolution for enrollments.
 *
 * An enrollment's client (its "subject") can be any actor: an account
 * (company), a contact (individual), a lead, or a partner. This mirrors the
 * established convention (`offers`, `client_threads`) and the resolver pattern
 * in lib/ai-agent/client-thread-follows.ts::resolveEntityName — extended here
 * to include partner and to batch lookups (no N+1).
 *
 * Display precedence: account → contact → lead → partner. A row carrying both
 * an account and a contact (a person who belongs to a company) resolves to the
 * company, matching client_threads semantics.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type {
  CommEnrollmentRow,
  EnrollmentSubject,
  EnrollmentSubjectType,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** The subject FK columns of an enrollment, used to pick the display subject. */
export type SubjectRefSource = Pick<
  CommEnrollmentRow,
  'account_id' | 'contact_id' | 'lead_id' | 'partner_id'
>

export interface SubjectRef {
  type: EnrollmentSubjectType
  id: string
}

/** Pick the single display subject from the polymorphic FKs (precedence order). */
export function pickSubjectRef(row: SubjectRefSource): SubjectRef | null {
  if (row.account_id) return { type: 'account', id: row.account_id }
  if (row.contact_id) return { type: 'contact', id: row.contact_id }
  if (row.lead_id) return { type: 'lead', id: row.lead_id }
  if (row.partner_id) return { type: 'partner', id: row.partner_id }
  return null
}

/** Per-type id → {name,email} lookup tables. */
export type SubjectNameMaps = Record<
  EnrollmentSubjectType,
  Map<string, { name: string; email: string | null }>
>

function emptyMaps(): SubjectNameMaps {
  return { account: new Map(), contact: new Map(), lead: new Map(), partner: new Map() }
}

/** Pure assembly: resolve a ref against pre-fetched name maps, with a safe fallback. */
export function buildSubject(ref: SubjectRef | null, maps: SubjectNameMaps): EnrollmentSubject {
  if (!ref) return { type: 'account', id: '', name: 'Client', email: null }
  const hit = maps[ref.type]?.get(ref.id)
  return {
    type: ref.type,
    id: ref.id,
    name: hit?.name ?? 'Client',
    email: hit?.email ?? null,
  }
}

/**
 * Batch-resolve subjects for many enrollment rows: collects ids per actor type,
 * runs at most one IN-query per table, then assembles. Returns a map keyed by
 * enrollment id. Degrades to "Client" for any subject row that no longer exists
 * (FKs are ON DELETE SET NULL, so a deleted subject leaves all FKs null → no ref).
 */
export async function resolveSubjectsBatch(
  rows: CommEnrollmentRow[],
): Promise<Map<string, EnrollmentSubject>> {
  const refByRow = new Map<string, SubjectRef | null>()
  const ids: Record<EnrollmentSubjectType, Set<string>> = {
    account: new Set(),
    contact: new Set(),
    lead: new Set(),
    partner: new Set(),
  }
  for (const row of rows) {
    const ref = pickSubjectRef(row)
    refByRow.set(row.id, ref)
    if (ref) ids[ref.type].add(ref.id)
  }

  const maps = emptyMaps()

  async function load(
    type: EnrollmentSubjectType,
    table: string,
    nameCol: string,
    emailCol: string | null,
  ): Promise<void> {
    const list = Array.from(ids[type])
    if (list.length === 0) return
    const cols = emailCol ? `id, ${nameCol}, ${emailCol}` : `id, ${nameCol}`
    const { data } = await db.from(table).select(cols).in('id', list)
    for (const r of data ?? []) {
      maps[type].set(r.id as string, {
        name: (r[nameCol] as string) ?? 'Client',
        email: emailCol ? ((r[emailCol] as string) ?? null) : null,
      })
    }
  }

  await Promise.all([
    load('account', 'accounts', 'company_name', null),
    load('contact', 'contacts', 'full_name', 'email'),
    load('lead', 'leads', 'full_name', 'email'),
    load('partner', 'client_partners', 'partner_name', 'partner_email'),
  ])

  const out = new Map<string, EnrollmentSubject>()
  for (const row of rows) {
    out.set(row.id, buildSubject(refByRow.get(row.id) ?? null, maps))
  }
  return out
}

/** Resolve a single enrollment's subject. */
export async function resolveSubject(row: CommEnrollmentRow): Promise<EnrollmentSubject> {
  const map = await resolveSubjectsBatch([row])
  return map.get(row.id) ?? buildSubject(pickSubjectRef(row), emptyMaps())
}
