/**
 * Server side of the offer-builder rollout (offer builder, dev job d2971d11): for ONE record, which new pieces may be
 * shown? The rules live in lib/offers/rollout.ts (off / test / on, set by Claude on Antonio's word — no screen, no button);
 * this file reads the stored values and, only when a piece is set to "test", looks up whether the record the screen is
 * about is marked as a test record (is_test = true on the company, the lead or the contact).
 *
 * Fails CLOSED everywhere: a failed settings read, a missing row, a record that cannot be found, an id that is not a
 * uuid — each means "not shown". The one place a piece can be on for a real client is the value `true` ("on"),
 * which only Claude writes when Antonio says so.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  NO_FEATURES,
  OFFER_BUILDER_FEATURE_KEYS,
  featureVisible,
  parseRolloutValue,
  type OfferBuilderFeature,
  type OfferBuilderFeatures,
  type RolloutMode,
} from '@/lib/offers/rollout'

/** What the screen knows. A draft offer's `token` is enough: the offer says which company / lead / contact it belongs to. */
export interface FeatureSubject {
  leadId?: string | null
  accountId?: string | null
  contactId?: string | null
  token?: string | null
}

export type SubjectTable = 'accounts' | 'leads' | 'contacts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cleanId = (v: string | null | undefined): string | null => (typeof v === 'string' && UUID.test(v.trim()) ? v.trim() : null)

/**
 * The record a screen is about. The company wins over the lead, the lead over the contact: the most specific record
 * decides, so a test company's offer is a test offer even when its contact was never marked.
 */
export function pickSubjectRecord(ids: { accountId?: string | null; leadId?: string | null; contactId?: string | null }): { table: SubjectTable; id: string } | null {
  const account = cleanId(ids.accountId)
  if (account) return { table: 'accounts', id: account }
  const lead = cleanId(ids.leadId)
  if (lead) return { table: 'leads', id: lead }
  const contact = cleanId(ids.contactId)
  if (contact) return { table: 'contacts', id: contact }
  return null
}

/** true / false when the record was found (a null is_test counts as NOT a test record), null when it could not be read. */
async function recordIsTest(table: SubjectTable, id: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin.from(table).select('is_test').eq('id', id).maybeSingle()
  if (error || !data) return null
  return (data as { is_test?: boolean | null }).is_test === true
}

/** Resolve the screen's context into the one record that decides. An offer token is read first; explicit ids fill the gaps. */
async function resolveSubject(subject: FeatureSubject): Promise<boolean | null> {
  const ids = { accountId: subject.accountId ?? null, leadId: subject.leadId ?? null, contactId: subject.contactId ?? null }
  const token = typeof subject.token === 'string' ? subject.token.trim() : ''
  if (token) {
    const { data, error } = await supabaseAdmin.from('offers').select('account_id, lead_id, contact_id').eq('token', token).maybeSingle()
    if (!error && data) {
      const o = data as { account_id?: string | null; lead_id?: string | null; contact_id?: string | null }
      ids.accountId = ids.accountId ?? o.account_id ?? null
      ids.leadId = ids.leadId ?? o.lead_id ?? null
      ids.contactId = ids.contactId ?? o.contact_id ?? null
    }
  }
  const record = pickSubjectRecord(ids)
  if (!record) return null
  return recordIsTest(record.table, record.id)
}

/**
 * Which pieces may be shown for this record. A failed settings read hides everything. When no piece is set to "test"
 * the record is never even looked up.
 */
export async function offerBuilderFeaturesFor(subject: FeatureSubject): Promise<OfferBuilderFeatures> {
  const features = Object.keys(OFFER_BUILDER_FEATURE_KEYS) as OfferBuilderFeature[]
  const { data, error } = await supabaseAdmin
    .from('app_settings')
    .select('key, value')
    .in('key', features.map((f) => OFFER_BUILDER_FEATURE_KEYS[f]))
  if (error || !data) return { ...NO_FEATURES }

  const stored = new Map<string, unknown>((data as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]))
  const modes = {} as Record<OfferBuilderFeature, RolloutMode>
  for (const f of features) modes[f] = parseRolloutValue(stored.get(OFFER_BUILDER_FEATURE_KEYS[f]))

  const needsRecord = features.some((f) => modes[f] === 'test')
  const isTest = needsRecord ? await resolveSubject(subject) : null

  const out: OfferBuilderFeatures = { ...NO_FEATURES }
  for (const f of features) out[f] = featureVisible(modes[f], isTest)
  return out
}
