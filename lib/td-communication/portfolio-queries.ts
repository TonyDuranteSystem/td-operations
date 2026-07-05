/**
 * TD Communication Phase 14 — portfolio data layer (server-side, service role).
 *
 * td_comm_portfolio is RLS ON / NO policy (like every td_comm_* table): the
 * browser never queries it; these helpers use supabaseAdmin after the API layer
 * authorized the caller (staff/admin for curation; nobody for the public read —
 * the public list returns only published, non-deleted rows). The table isn't in
 * the generated Supabase types, so we go through an untyped client and shape rows.
 *
 * Consent is SOFT (see showcase-consent.ts): the curator list resolves a
 * consent_state for the badge but publishing is never blocked. A withdrawal
 * auto-unpublishes via unpublishEntriesForEnrollment (called by the withdraw route).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { removePublicAssetByUrl } from './copy-to-public'
import { getActiveConsentForEnrollment } from './showcase-consent'
import { deriveConsentState, validatePortfolioInput } from './portfolio'
import type {
  PortfolioEntry,
  PortfolioEntryInput,
  PortfolioEntryWithConsent,
  ShowcaseConsent,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Public-bucket prefix the Phase 14 copies live under (used for cleanup). */
export const PORTFOLIO_ASSET_PREFIX = 'portfolio'

const COLUMNS =
  'id, enrollment_id, title_en, title_it, client_name, description_en, description_it, ' +
  'before_image_url, after_image_url, category, tags, published, featured, sort_order, ' +
  'consent_source, consent_id, attested_by, attested_at, deleted_at, deleted_by, ' +
  'created_by, created_at, updated_at'

function shape(row: Record<string, unknown> | null): PortfolioEntry | null {
  if (!row) return null
  return {
    id: String(row.id),
    enrollment_id: (row.enrollment_id as string) ?? null,
    title_en: String(row.title_en ?? ''),
    title_it: String(row.title_it ?? ''),
    client_name: String(row.client_name ?? ''),
    description_en: String(row.description_en ?? ''),
    description_it: String(row.description_it ?? ''),
    before_image_url: (row.before_image_url as string) ?? null,
    after_image_url: String(row.after_image_url ?? ''),
    category: (row.category as string) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    published: row.published === true,
    featured: row.featured === true,
    sort_order: Number(row.sort_order) || 0,
    consent_source: (row.consent_source as PortfolioEntry['consent_source']) ?? 'none',
    consent_id: (row.consent_id as string) ?? null,
    attested_by: (row.attested_by as string) ?? null,
    attested_at: (row.attested_at as string) ?? null,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** Curator list: every non-deleted entry, newest first, with a resolved consent badge state. */
export async function listPortfolioForCurator(): Promise<PortfolioEntryWithConsent[]> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .select(COLUMNS)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  const entries = (data ?? []).map(shape).filter(Boolean) as PortfolioEntry[]

  // Batch-fetch the linked consent rows to resolve the badge state.
  const consentIds = Array.from(
    new Set(entries.map((e) => e.consent_id).filter((id): id is string => !!id)),
  )
  const consentById = new Map<string, ShowcaseConsent>()
  if (consentIds.length > 0) {
    const { data: consents, error: cErr } = await db
      .from('td_comm_showcase_consents')
      .select('id, revoked_at')
      .in('id', consentIds)
    if (cErr) throw new Error(cErr.message)
    for (const c of consents ?? []) consentById.set(String(c.id), c as ShowcaseConsent)
  }

  return entries.map((e) => ({
    ...e,
    consent_state: deriveConsentState(e, e.consent_id ? consentById.get(e.consent_id) : null),
  }))
}

/**
 * Public list: published, non-deleted entries. Featured first, then sort_order,
 * then newest. This is the ONLY read the unauthenticated page/API uses.
 */
export async function listPublishedPortfolio(): Promise<PortfolioEntry[]> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .select(COLUMNS)
    .eq('published', true)
    .is('deleted_at', null)
    .order('featured', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(shape).filter(Boolean) as PortfolioEntry[]
}

/** One entry by id (non-deleted), or null. */
export async function getPortfolioEntry(id: string): Promise<PortfolioEntry | null> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .select(COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return shape(data)
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/** Next sort_order = max(existing non-deleted) + 1, so new entries append. */
async function nextSortOrder(): Promise<number> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .select('sort_order')
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (Number(data?.sort_order) || 0) + 1
}

/**
 * Create an entry (draft — published=false). Input is validated/sanitized first;
 * throws with the validation error if the required "after" image is missing.
 */
export async function createPortfolioEntry(
  input: PortfolioEntryInput,
  createdBy: string | null,
): Promise<PortfolioEntry> {
  const { value, error: vErr } = validatePortfolioInput(input)
  if (!value) throw new Error(vErr ?? 'Invalid portfolio entry.')

  // Auto-link a client opt-in: if a source project is set and the curator didn't
  // explicitly attest written permission, resolve the project's active consent and
  // record it as the basis (so the badge reflects reality without extra clicks).
  if (value.enrollment_id && value.consent_source !== 'written_on_file' && !value.consent_id) {
    const consent = await getActiveConsentForEnrollment(value.enrollment_id)
    if (consent) {
      value.consent_source = 'client_optin'
      value.consent_id = consent.id
    }
  }

  const sort_order = await nextSortOrder()
  const { data, error } = await db
    .from('td_comm_portfolio')
    .insert({ ...value, sort_order, created_by: createdBy })
    .select(COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return shape(data)!
}

/** Update an entry's content/metadata (not published/sort — those have their own paths). */
export async function updatePortfolioEntry(id: string, input: PortfolioEntryInput): Promise<PortfolioEntry> {
  const { value, error: vErr } = validatePortfolioInput(input)
  if (!value) throw new Error(vErr ?? 'Invalid portfolio entry.')
  const { data, error } = await db
    .from('td_comm_portfolio')
    .update({ ...value, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return shape(data)!
}

/** Toggle published (admin-only at the route). */
export async function setPortfolioPublished(id: string, published: boolean): Promise<PortfolioEntry> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .update({ published, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return shape(data)!
}

/** Toggle featured. */
export async function setPortfolioFeatured(id: string, featured: boolean): Promise<PortfolioEntry> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .update({ featured, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return shape(data)!
}

/** Record an admin "written permission on file" attestation as the consent basis. */
export async function attestWrittenConsent(id: string, attestedBy: string | null): Promise<PortfolioEntry> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .update({
      consent_source: 'written_on_file',
      attested_by: attestedBy,
      attested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return shape(data)!
}

/** Persist a new order: set sort_order to the array index for each id. */
export async function reorderPortfolio(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await db
      .from('td_comm_portfolio')
      .update({ sort_order: i, updated_at: new Date().toISOString() })
      .eq('id', orderedIds[i])
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
  }
}

/**
 * Soft-delete (R100): stamp deleted_at/by and best-effort remove the copied public
 * images so a deleted entry's brand work does not linger publicly.
 */
export async function softDeletePortfolioEntry(id: string, deletedBy: string | null): Promise<void> {
  const entry = await getPortfolioEntry(id)
  const { error } = await db
    .from('td_comm_portfolio')
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy, published: false })
    .eq('id', id)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
  if (entry) {
    await removePublicAssetByUrl(entry.before_image_url, PORTFOLIO_ASSET_PREFIX)
    await removePublicAssetByUrl(entry.after_image_url, PORTFOLIO_ASSET_PREFIX)
  }
}

/**
 * On consent withdrawal: unpublish every entry tied to this enrollment and remove
 * its copied public images. Returns the number of entries affected. Best-effort
 * image cleanup never throws (the DB unpublish is the source of truth).
 */
export async function unpublishEntriesForEnrollment(enrollmentId: string): Promise<{ unpublished: number }> {
  const { data, error } = await db
    .from('td_comm_portfolio')
    .select('id, before_image_url, after_image_url')
    .eq('enrollment_id', enrollmentId)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ id: string; before_image_url: string | null; after_image_url: string | null }>
  if (rows.length === 0) return { unpublished: 0 }

  const { error: upErr } = await db
    .from('td_comm_portfolio')
    .update({ published: false, updated_at: new Date().toISOString() })
    .eq('enrollment_id', enrollmentId)
    .is('deleted_at', null)
  if (upErr) throw new Error(upErr.message)

  for (const r of rows) {
    await removePublicAssetByUrl(r.before_image_url, PORTFOLIO_ASSET_PREFIX)
    await removePublicAssetByUrl(r.after_image_url, PORTFOLIO_ASSET_PREFIX)
  }
  return { unpublished: rows.length }
}
