/**
 * TD Communication — deliverables data layer (server-side, service role).
 *
 * Backs the deliverables manager in the creative-brief panel. Like the rest of
 * td-communication, td_comm_deliverables is RLS ON with NO policy: the browser
 * never queries it; these helpers use supabaseAdmin (RLS bypass) and assume the
 * API layer already authenticated + authorized the caller (resolveCommParticipant).
 *
 * Files live in the PRIVATE `td-comm-deliverables` bucket — `file_url` holds the
 * storage PATH, and these helpers mint short-lived signed URLs on read:
 *   - preview_url  (inline)            → image thumbnails
 *   - download_url ({ download } opt)  → forced-attachment download
 * The manager always exposes both regardless of is_draft — is_draft is a future
 * CLIENT-side gate (watermark + download-block), not a staff/partner one.
 *
 * The table is not in the generated Supabase types, so we go through an untyped
 * client (matches pipeline-queries.ts) and shape rows into ./types.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { nextStatusOnUpload, nextStatusOnReleaseFinal, nextStatusOnRelease } from './pipeline'
import { nextVersionForConcept } from './deliverables'
import type { CommDeliverable, DeliverableType } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BUCKET = 'td-comm-deliverables'
const SIGNED_URL_TTL = 60 * 60 * 6 // 6 hours

const DELIVERABLE_COLUMNS =
  'id, enrollment_id, type, file_url, drive_file_id, file_name, file_size, mime_type, is_draft, concept_number, version_number, watermark_applied, released_at, released_by, created_at'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shape(row: any): CommDeliverable {
  return {
    id: row.id,
    enrollment_id: row.enrollment_id,
    type: row.type as DeliverableType,
    file_url: row.file_url ?? null,
    drive_file_id: row.drive_file_id ?? null,
    file_name: row.file_name,
    file_size: row.file_size ?? null,
    mime_type: row.mime_type ?? null,
    is_draft: !!row.is_draft,
    concept_number: Number(row.concept_number) || 1,
    version_number: Number(row.version_number) || 1,
    watermark_applied: !!row.watermark_applied,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    created_at: row.created_at,
  }
}

/**
 * Attach signed preview (inline) + download (forced-attachment) URLs. Previews
 * are batch-signed in one round-trip; downloads need a per-file `download` name
 * so they are minted individually. Rows without a stored path get nulls.
 */
async function withSignedUrls(rows: CommDeliverable[]): Promise<CommDeliverable[]> {
  const paths = rows.map((r) => r.file_url).filter((p): p is string => !!p)
  const previewMap = new Map<string, string>()
  if (paths.length > 0) {
    const { data: previews } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL)
    if (Array.isArray(previews)) {
      for (const p of previews) {
        if (p?.path && p?.signedUrl) previewMap.set(p.path, p.signedUrl)
      }
    }
  }

  return Promise.all(
    rows.map(async (r) => {
      if (!r.file_url) return { ...r, preview_url: null, download_url: null }
      let download_url: string | null = null
      const { data: dl } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(r.file_url, SIGNED_URL_TTL, { download: r.file_name || true })
      if (dl?.signedUrl) download_url = dl.signedUrl
      return { ...r, preview_url: previewMap.get(r.file_url) ?? null, download_url }
    }),
  )
}

/** Active (non-deleted) deliverables for an enrollment, newest first, signed. */
export async function listDeliverables(enrollmentId: string): Promise<CommDeliverable[]> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select(DELIVERABLE_COLUMNS)
    .eq('enrollment_id', enrollmentId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []).map((r: any) => shape(r))
  return withSignedUrls(rows)
}

/**
 * Released IMAGE deliverables across all enrollments, newest first, with signed
 * preview URLs — backs the landing editor's "Add from deliverables" picker
 * (Phase 9). Only released, non-deleted image files; capped for the picker.
 */
export async function listReleasedImageDeliverables(limit = 60): Promise<CommDeliverable[]> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select(DELIVERABLE_COLUMNS)
    .not('released_at', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []).map((r: any) => shape(r))
  const images = rows.filter((r: CommDeliverable) => {
    const mime = (r.mime_type ?? '').toLowerCase()
    const ext = (r.file_name?.split('.').pop() ?? '').toLowerCase()
    return mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
  })
  return withSignedUrls(images)
}

/** A single active deliverable (for ownership checks / re-signing). */
export async function getDeliverable(delivId: string): Promise<CommDeliverable | null> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select(DELIVERABLE_COLUMNS)
    .eq('id', delivId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return shape(data)
}

export interface CreateDeliverableInput {
  type: DeliverableType
  /** Storage path in the private bucket (returned by the upload-url route). */
  file_url: string
  file_name: string
  file_size?: number | null
  mime_type?: string | null
  /** Concept the file belongs to (A=1, B=2…). Defaults to 1. */
  concept_number?: number
}

/**
 * Record a deliverable after the file has been uploaded to storage. The version
 * number is SERVER-AUTHORITATIVE: always max+1 within (enrollment, concept), so
 * two near-simultaneous uploads to the same concept never collide on a version.
 * Auto-advances the board (Ready for Review) when appropriate.
 */
export async function createDeliverable(
  enrollmentId: string,
  input: CreateDeliverableInput,
): Promise<CommDeliverable> {
  const concept =
    Number.isFinite(input.concept_number) && (input.concept_number as number) >= 1
      ? Math.floor(input.concept_number as number)
      : 1

  const { data: existing } = await db
    .from('td_comm_deliverables')
    .select('concept_number, version_number')
    .eq('enrollment_id', enrollmentId)
    .eq('concept_number', concept)
    .is('deleted_at', null)
  const version = nextVersionForConcept(existing ?? [], concept)

  const { data, error } = await db
    .from('td_comm_deliverables')
    .insert({
      enrollment_id: enrollmentId,
      type: input.type,
      file_url: input.file_url,
      file_name: input.file_name,
      file_size: input.file_size ?? null,
      mime_type: input.mime_type ?? null,
      concept_number: concept,
      version_number: version,
      is_draft: true,
    })
    .select(DELIVERABLE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Could not save the deliverable.')

  await advanceStatus(enrollmentId, nextStatusOnUpload)

  const [signed] = await withSignedUrls([shape(data)])
  return signed
}

export type DeliverablePatch =
  | { action: 'release' }
  | { action: 'release_final' }
  | { action: 'update'; type?: DeliverableType; concept_number?: number }

/**
 * Update a deliverable: release to client (stamp released_at/by), release final
 * (is_draft=false + ensure released + advance board to Delivered), or edit
 * metadata (type / concept).
 */
export async function updateDeliverable(
  delivId: string,
  patch: DeliverablePatch,
  actor?: string | null,
): Promise<CommDeliverable> {
  const current = await getDeliverable(delivId)
  if (!current) throw new Error('Deliverable not found.')

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields: Record<string, any> = {}

  if (patch.action === 'release') {
    fields.released_at = current.released_at ?? now
    fields.released_by = actor ?? current.released_by ?? null
  } else if (patch.action === 'release_final') {
    fields.is_draft = false
    fields.released_at = current.released_at ?? now
    fields.released_by = actor ?? current.released_by ?? null
  } else {
    if (patch.type !== undefined) fields.type = patch.type
    if (patch.concept_number !== undefined && Number.isFinite(patch.concept_number)) {
      fields.concept_number = Math.max(1, Math.floor(patch.concept_number))
    }
    if (Object.keys(fields).length === 0) return current // nothing to change
  }

  const { data, error } = await db
    .from('td_comm_deliverables')
    .update(fields)
    .eq('id', delivId)
    .is('deleted_at', null)
    .select(DELIVERABLE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Deliverable not found.')

  if (patch.action === 'release_final') {
    await advanceStatus(current.enrollment_id, nextStatusOnReleaseFinal)
  } else if (patch.action === 'release') {
    // Releasing a draft to the client triggers the Phase 7 disclaimer + reveal,
    // so the project is now Ready for Review (concept_ready). Forward-only, never
    // throws (same optimistic helper as upload / release_final).
    await advanceStatus(current.enrollment_id, nextStatusOnRelease)
  }

  const [signed] = await withSignedUrls([shape(data)])
  return signed
}

/** Soft-delete (R100): preserve the row + storage object; hide from the list. */
export async function softDeleteDeliverable(delivId: string, actor?: string | null): Promise<void> {
  const { error } = await db
    .from('td_comm_deliverables')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actor ?? null })
    .eq('id', delivId)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
}

/**
 * Forward-only, optimistic board advance: read the enrollment's status, ask the
 * pure decider for a target, and update only if the status is still what we read
 * (the `.eq('status', current)` guard makes it a no-op under a concurrent edit).
 * Never throws — auto-advance must not fail the deliverable write.
 */
async function advanceStatus(
  enrollmentId: string,
  decide: (current: string) => string | null,
): Promise<void> {
  try {
    const { data: enr } = await db
      .from('td_comm_enrollments')
      .select('status, metadata')
      .eq('id', enrollmentId)
      .maybeSingle()
    if (!enr) return
    const target = decide(enr.status)
    if (!target || target === enr.status) return
    const update: Record<string, unknown> = { status: target, updated_at: new Date().toISOString() }
    // First time we land on 'delivered', stamp metadata.delivered_at (merge,
    // idempotent) so the admin avg-delivery stat is real.
    if (target === 'delivered') {
      const meta = (enr.metadata ?? {}) as Record<string, unknown>
      if (!meta.delivered_at) update.metadata = { ...meta, delivered_at: new Date().toISOString() }
    }
    await db
      .from('td_comm_enrollments')
      .update(update)
      .eq('id', enrollmentId)
      .eq('status', enr.status)
  } catch (err) {
    console.warn('[deliverables] status auto-advance failed:', err)
  }
}
