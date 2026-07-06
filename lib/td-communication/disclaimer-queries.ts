/**
 * TD Communication — disclaimer + released-concept data layer (server-side,
 * service role). Backs the Phase 7 client disclaimer gate + logo reveal.
 *
 * Like the rest of td-communication, td_comm_disclaimers / td_comm_deliverables
 * are RLS ON with NO policy: the browser never queries them; these helpers use
 * supabaseAdmin (RLS bypass) after the API layer authenticated + authorized the
 * caller (the client owns the enrollment). The tables are not in the generated
 * Supabase types, so we go through an untyped client (matches the sibling query
 * modules) and shape the rows.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BUCKET = 'td-comm-deliverables'
const SIGNED_URL_TTL = 60 * 60 * 6 // 6 hours, mirrors deliverables-queries

/* -------------------------------------------------------------------------- */
/* Disclaimer acceptance                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Has THIS enrollment accepted THIS disclaimer version? Version-keyed on
 * purpose: when the terms are edited the version (a content hash) changes, so a
 * client who accepted the old wording is re-gated on the new wording.
 */
export async function hasAcceptedDisclaimer(
  enrollmentId: string,
  version: string,
): Promise<boolean> {
  const { count, error } = await db
    .from('td_comm_disclaimers')
    .select('id', { count: 'exact', head: true })
    .eq('enrollment_id', enrollmentId)
    .eq('disclaimer_version', version)
  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
}

export interface RecordDisclaimerInput {
  enrollmentId: string
  contactId: string | null
  version: string
  ipAddress: string | null
  userAgent: string | null
  method?: 'click' | 'docusign'
}

/**
 * Record a disclaimer acceptance. Idempotent: if this (enrollment, version) was
 * already accepted we return `{ already: true }` without inserting a second row
 * — a double-click never spams the legal log. IP/user-agent are passed in by the
 * route (read server-side from the request, never trusted from the body).
 */
export async function recordDisclaimerAcceptance(
  input: RecordDisclaimerInput,
): Promise<{ already: boolean }> {
  if (await hasAcceptedDisclaimer(input.enrollmentId, input.version)) {
    return { already: true }
  }
  const { error } = await db.from('td_comm_disclaimers').insert({
    enrollment_id: input.enrollmentId,
    contact_id: input.contactId,
    disclaimer_version: input.version,
    ip_address: input.ipAddress,
    user_agent: input.userAgent,
    method: input.method ?? 'click',
  })
  if (error) throw new Error(error.message)
  return { already: false }
}

/* -------------------------------------------------------------------------- */
/* Released concepts (client-facing, preview-only)                             */
/* -------------------------------------------------------------------------- */

/** A single released concept image, shaped for the client reveal (no download). */
export interface ClientConceptItem {
  id: string
  /** Signed, short-lived inline preview URL (private bucket). */
  preview_url: string | null
  file_name: string
  version_number: number
}

/** Released concept images grouped by concept (A/B/C), newest version first. */
export interface ClientConceptGroup {
  concept_number: number
  items: ClientConceptItem[]
}

function isImageRow(mime: string | null, fileName: string | null): boolean {
  const m = (mime ?? '').toLowerCase()
  const ext = (fileName?.split('.').pop() ?? '').toLowerCase()
  return m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
}

/**
 * Released IMAGE deliverables for one enrollment, grouped by concept, each with
 * a signed PREVIEW url only (no forced-download — drafts stay download-blocked
 * for the client). Returns [] when nothing is released yet.
 *
 * Faithful to the spec's reveal filter: released_at IS NOT NULL (visible to the
 * client) and not soft-deleted. is_draft is NOT filtered here — a concept stays
 * shown after it's released, and the approved view reuses the same set.
 */
export async function listReleasedConceptsForClient(
  enrollmentId: string,
): Promise<ClientConceptGroup[]> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select('id, file_url, file_name, mime_type, concept_number, version_number, released_at')
    .eq('enrollment_id', enrollmentId)
    .not('released_at', 'is', null)
    .is('deleted_at', null)
    // Phase 12/15: never surface design-tool outputs (mockups / asset kits) or the
    // Phase 15 social kit in the client's logo reveal — it is for logo concepts only
    // (defense in depth; the social kit reaches the client via its OWN portal
    // endpoint, and it's a zip that would never pass the image filter anyway).
    .not('type', 'in', '("mockup","asset_kit","social_kit")')
    .order('concept_number', { ascending: true })
    .order('version_number', { ascending: false })
  if (error) throw new Error(error.message)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const images = (data ?? []).filter((r: any) => isImageRow(r.mime_type, r.file_name))
  if (images.length === 0) return []

  // Batch-sign the preview URLs in one round-trip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paths = images.map((r: any) => r.file_url).filter((p: unknown): p is string => !!p)
  const previewMap = new Map<string, string>()
  if (paths.length > 0) {
    const { data: previews } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL)
    if (Array.isArray(previews)) {
      for (const p of previews) {
        if (p?.path && p?.signedUrl) previewMap.set(p.path, p.signedUrl)
      }
    }
  }

  const groups = new Map<number, ClientConceptGroup>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of images as any[]) {
    const concept = Number(r.concept_number) || 1
    if (!groups.has(concept)) groups.set(concept, { concept_number: concept, items: [] })
    groups.get(concept)!.items.push({
      id: r.id,
      preview_url: r.file_url ? (previewMap.get(r.file_url) ?? null) : null,
      file_name: r.file_name,
      version_number: Number(r.version_number) || 1,
    })
  }
  return Array.from(groups.values()).sort((a, b) => a.concept_number - b.concept_number)
}
