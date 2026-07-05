/**
 * TD Communication — copy a released deliverable's image from the PRIVATE
 * `td-comm-deliverables` bucket into the PUBLIC `assets` bucket, returning a
 * public URL. Extracted (Phase 14) from the Phase 9 landing
 * `portfolio-from-deliverable` route so the landing editor AND the portfolio
 * manager share one copy path instead of duplicating it.
 *
 * Server-only (uses supabaseAdmin). The public page/gallery is unauthenticated
 * and cacheable, so it must reference a PUBLIC URL — a short-lived signed URL
 * from the private bucket would expire. Callers own auth + the released check is
 * enforced here too (defense in depth).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { randomUUID } from 'crypto'

export const DELIVERABLES_BUCKET = 'td-comm-deliverables' // private
export const PUBLIC_ASSETS_BUCKET = 'assets' // public

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/** Resolve a normalized image extension from a filename/mime, or '' if not an image. */
export function imageExtFor(fileName: string | null, mime: string | null): string {
  const fromName = (fileName?.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (IMAGE_EXTS.has(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  return ''
}

/** The minimal deliverable shape this helper needs. */
export interface DeliverableForCopy {
  file_url: string | null
  file_name: string | null
  mime_type: string | null
  released_at: string | null
}

/**
 * Result of a copy attempt. A single shape with optional fields (not a
 * discriminated union) because the repo's tsconfig has `strict: false` /
 * strictNullChecks off, under which boolean-discriminant narrowing does not work.
 * On success: { ok: true, publicUrl, path }. On failure: { ok: false, status, error }.
 */
export interface CopyResult {
  ok: boolean
  publicUrl?: string
  path?: string
  status?: number
  error?: string
}

/**
 * Copy a RELEASED image deliverable into the public assets bucket under
 * `${destPrefix}/<uuid>.<ext>`. Returns a discriminated result so each caller
 * maps it to its own HTTP response with the exact same messages/statuses the
 * Phase 9 route used. Only released image deliverables are eligible.
 */
export async function copyDeliverableImageToPublic(
  deliverable: DeliverableForCopy,
  destPrefix: string,
): Promise<CopyResult> {
  if (!deliverable.released_at) {
    return { ok: false, status: 400, error: 'Only released deliverables can be shown in the portfolio.' }
  }
  if (!deliverable.file_url) {
    return { ok: false, status: 400, error: 'This deliverable has no file to copy.' }
  }
  const ext = imageExtFor(deliverable.file_name, deliverable.mime_type)
  if (!ext) {
    return { ok: false, status: 400, error: 'Only image deliverables can be added to the portfolio.' }
  }

  const { data: blob, error: dlErr } = await supabaseAdmin.storage
    .from(DELIVERABLES_BUCKET)
    .download(deliverable.file_url)
  if (dlErr || !blob) {
    console.error('copy-to-public — download error:', dlErr)
    return { ok: false, status: 500, error: 'Could not read the deliverable file.' }
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const contentType = deliverable.mime_type || `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const path = `${destPrefix}/${randomUUID()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .upload(path, buffer, { contentType, upsert: false })
  if (upErr) {
    console.error('copy-to-public — upload error:', upErr)
    return { ok: false, status: 500, error: 'Could not copy the image. Please try again.' }
  }
  const { data: urlData } = supabaseAdmin.storage.from(PUBLIC_ASSETS_BUCKET).getPublicUrl(path)
  return { ok: true, publicUrl: urlData.publicUrl, path }
}

/**
 * Best-effort removal of a public `assets` object given its public URL. Used when
 * a portfolio entry is hard-deleted or a client withdraws consent, so the copied
 * brand image does not linger publicly. Never throws — a failed cleanup must not
 * break the withdrawal/delete it follows (the DB state is the source of truth).
 * Only removes objects under the given `prefix` (guards against a malformed URL
 * deleting an unrelated asset).
 */
export async function removePublicAssetByUrl(publicUrl: string | null | undefined, prefix: string): Promise<void> {
  if (!publicUrl) return
  const marker = `/${PUBLIC_ASSETS_BUCKET}/`
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return
  const path = publicUrl.slice(idx + marker.length).split('?')[0]
  if (!path || !path.startsWith(`${prefix}/`)) return
  try {
    await supabaseAdmin.storage.from(PUBLIC_ASSETS_BUCKET).remove([path])
  } catch (err) {
    console.error('copy-to-public — remove error (non-fatal):', err)
  }
}
