/**
 * TD Communication — Client Landing Page (Phase 16) data layer (service role).
 *
 * td_comm_landing_sites is RLS ON with NO policy (like every td_comm_* table):
 * the browser never queries it; these helpers use supabaseAdmin (RLS bypass) and
 * assume the API layer already authorized the caller (staff/scoped-partner for the
 * editor; the public read is gated by the kill-switch + published flag).
 *
 * The table is not in the generated Supabase types, so we go through an untyped
 * client and shape rows via shapeSite().
 */

import { randomBytes } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { APP_BASE_URL } from '@/lib/config'
import { isUniqueViolation } from '@/lib/portal/invoice-number'
import { removePublicAssetByUrl } from './copy-to-public'
import {
  validateClientLandingContent,
  toPublicSite,
  slugStem,
  supersededImageUrls,
  defaultLandingContent,
} from './client-landing'
import type {
  ClientLandingContent,
  ClientLandingSite,
  ClientLandingEditorState,
  PublicClientLanding,
  ClandTheme,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const TABLE = 'td_comm_landing_sites'
const SLUG_CONSTRAINT = 'td_comm_landing_sites_slug_key'
const PUBLIC_ASSET_PREFIX = 'client-landing'
const COLUMNS =
  'id, enrollment_id, slug, title, content, published_content, published, published_at, published_by, deleted_at, deleted_by, created_by, created_at, updated_at'

/** A concurrent-edit conflict — the API maps this to HTTP 409. */
export class StaleEditError extends Error {
  code = 'STALE_EDIT'
  constructor() {
    super('This landing page was changed elsewhere. Reload to get the latest version.')
    this.name = 'StaleEditError'
  }
}

/** Shape a raw DB row into a typed, sanitized site. */
export function shapeSite(row: Record<string, unknown>): ClientLandingSite {
  return {
    id: String(row.id),
    enrollment_id: (row.enrollment_id as string | null) ?? null,
    slug: String(row.slug),
    title: String(row.title ?? ''),
    content: validateClientLandingContent(row.content as Partial<ClientLandingContent> | null),
    published_content:
      row.published_content == null ? null : validateClientLandingContent(row.published_content as Partial<ClientLandingContent>),
    published: Boolean(row.published),
    published_at: (row.published_at as string | null) ?? null,
    published_by: (row.published_by as string | null) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

/** Full public URL for a slug. */
export function publicUrlForSlug(slug: string): string {
  return `${APP_BASE_URL}/site/${slug}`
}

function editorState(site: ClientLandingSite): ClientLandingEditorState {
  const hasUnpublishedChanges =
    !site.published ||
    JSON.stringify(site.content) !== JSON.stringify(site.published_content)
  return { site, hasUnpublishedChanges, publicUrl: publicUrlForSlug(site.slug) }
}

/** The newest non-deleted site for an enrollment, or null. */
export async function getSiteForEnrollment(enrollmentId: string): Promise<ClientLandingSite | null> {
  const { data, error } = await db
    .from(TABLE)
    .select(COLUMNS)
    .eq('enrollment_id', enrollmentId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? shapeSite(data) : null
}

export async function getSiteForEnrollmentAsEditorState(
  enrollmentId: string,
): Promise<ClientLandingEditorState | null> {
  const site = await getSiteForEnrollment(enrollmentId)
  return site ? editorState(site) : null
}

/** Random 4-hex disambiguator so slugs aren't trivially enumerable. */
function randSuffix(): string {
  return randomBytes(2).toString('hex') // 4 lowercase hex chars
}

/**
 * Create a site for an enrollment. Slug = slugStem(title)-<rand4>, with a retry
 * loop on unique-violation (R098 discipline — the DB constraint is the race guard,
 * a fresh suffix disambiguates). Caller authorizes first.
 */
export async function createSite(params: {
  enrollmentId: string
  title: string
  actor: string
  theme?: ClandTheme
}): Promise<ClientLandingSite> {
  const stem = slugStem(params.title)
  const content = defaultLandingContent({ theme: params.theme })
  const now = new Date().toISOString()
  const base = {
    enrollment_id: params.enrollmentId,
    title: (params.title || '').trim().slice(0, 160),
    content,
    published: false,
    created_by: params.actor,
    created_at: now,
    updated_at: now,
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = `${stem}-${randSuffix()}`
    const { data, error } = await db.from(TABLE).insert({ ...base, slug }).select(COLUMNS).maybeSingle()
    if (!error && data) return shapeSite(data)
    if (error && isUniqueViolation(error, SLUG_CONSTRAINT)) continue // collision — new suffix
    if (error) throw new Error(error.message)
  }
  throw new Error('Could not generate a unique landing-page address. Please try again.')
}

/** Load a site by id (non-deleted), or null. */
export async function getSiteById(id: string): Promise<ClientLandingSite | null> {
  const { data, error } = await db.from(TABLE).select(COLUMNS).eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? shapeSite(data) : null
}

/**
 * Save the draft content under OPTIMISTIC CONCURRENCY: the update only lands if
 * `updated_at` still equals `expectedUpdatedAt`. A mismatch (another editor / tab
 * saved first) throws StaleEditError → the API returns 409. Also best-effort
 * cleans up any public image the edit superseded (not referenced by the new draft
 * NOR the published snapshot).
 */
export async function saveDraft(params: {
  id: string
  content: ClientLandingContent
  expectedUpdatedAt: string
  actor: string
}): Promise<ClientLandingSite> {
  const current = await getSiteById(params.id)
  if (!current) throw new Error('Landing page not found.')
  const cleanContent = validateClientLandingContent(params.content)
  const now = new Date().toISOString()
  const { data, error } = await db
    .from(TABLE)
    .update({ content: cleanContent, updated_at: now })
    .eq('id', params.id)
    .eq('updated_at', params.expectedUpdatedAt)
    .is('deleted_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new StaleEditError()
  // Best-effort orphan cleanup — never blocks the save.
  for (const url of supersededImageUrls(current.content, cleanContent, current.published_content)) {
    await removePublicAssetByUrl(url, PUBLIC_ASSET_PREFIX)
  }
  return shapeSite(data)
}

/** Rename the slug (uniqueness-guarded). Returns the updated site. */
export async function setSlug(params: {
  id: string
  slug: string
  expectedUpdatedAt: string
}): Promise<ClientLandingSite> {
  const clean = slugStem(params.slug) // normalize to a valid kebab stem
  const now = new Date().toISOString()
  const { data, error } = await db
    .from(TABLE)
    .update({ slug: clean, updated_at: now })
    .eq('id', params.id)
    .eq('updated_at', params.expectedUpdatedAt)
    .is('deleted_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) {
    if (isUniqueViolation(error, SLUG_CONSTRAINT)) {
      throw new Error(`The address "${clean}" is already taken. Choose another.`)
    }
    throw new Error(error.message)
  }
  if (!data) throw new StaleEditError()
  return shapeSite(data)
}

/** Publish: freeze the current draft into published_content and go live. */
export async function publishSite(params: { id: string; actor: string }): Promise<ClientLandingSite> {
  const current = await getSiteById(params.id)
  if (!current) throw new Error('Landing page not found.')
  const now = new Date().toISOString()
  const { data, error } = await db
    .from(TABLE)
    .update({
      published_content: current.content,
      published: true,
      published_at: now,
      published_by: params.actor,
      updated_at: now,
    })
    .eq('id', params.id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Landing page not found.')
  return shapeSite(data)
}

/** Unpublish: hide the public page (keeps the draft + the frozen snapshot). */
export async function unpublishSite(params: { id: string; actor: string }): Promise<ClientLandingSite> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from(TABLE)
    .update({ published: false, updated_at: now })
    .eq('id', params.id)
    .is('deleted_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Landing page not found.')
  return shapeSite(data)
}

/** Soft-delete (R100). Also best-effort removes all copied public images. */
export async function softDeleteSite(params: { id: string; actor: string }): Promise<void> {
  const current = await getSiteById(params.id)
  if (!current) return
  const now = new Date().toISOString()
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: now, deleted_by: params.actor, published: false, updated_at: now })
    .eq('id', params.id)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
  const urls = Array.from(
    new Set<string>([
      ...supersededImageUrls(current.content, null, null),
      ...supersededImageUrls(current.published_content, null, null),
    ]),
  )
  for (const url of urls) await removePublicAssetByUrl(url, PUBLIC_ASSET_PREFIX)
}

/**
 * The ONLY public read: a published, non-deleted site by slug, projected to the
 * public-safe subset (re-sanitized). Returns null when nothing is live at that slug.
 */
export async function getPublishedSiteBySlug(slug: string): Promise<PublicClientLanding | null> {
  const { data, error } = await db
    .from(TABLE)
    .select('title, published_content, published, deleted_at')
    .eq('slug', slug)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.published_content == null) return null
  return toPublicSite({ title: String(data.title ?? ''), published_content: data.published_content as ClientLandingContent })
}
