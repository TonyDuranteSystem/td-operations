/**
 * TD Communication — creative-brief uploaded-materials signing (server-side).
 *
 * A rebrand client's `upload_materials` file field stores an array of storage
 * PATHS in the private `onboarding-uploads` bucket (the shared bucket every
 * portal wizard uploads to). `groupBrief` extracts those paths into
 * `uploads[].url`, but a private-bucket path is not fetchable — the staff brief
 * needs a short-lived SIGNED url to open the file.
 *
 * Split from the query layer so the merge is pure + unit-testable (R086):
 *   - `applySignedUrls` (pure): swap each upload's path for its signed url, or ''
 *     when it couldn't be signed (deleted object / bad path) → the panel renders
 *     that entry as non-clickable "unavailable" instead of a broken link.
 *   - `signBriefUploads` (I/O): call the generic signer, then apply the map.
 */

import { createSignedUrlMap } from '@/lib/storage/signed-urls'
import type { BriefUpload } from './pipeline'

/** The shared bucket every portal wizard (formation, tax, td_communication, …)
 *  uploads file fields to. Uploaded materials in a brand-audit submission live
 *  here as `td_communication/<id>/upload_materials_<uid>_<file>`. */
export const WIZARD_UPLOAD_BUCKET = 'onboarding-uploads'

/**
 * Pure: replace each upload's `url` (a storage path) with its signed URL from
 * `signed`. A path missing from the map (couldn't be signed) becomes '' so the
 * UI can show it as unavailable rather than link to a dead path. Preserves order
 * and every other field (name, mime_type).
 */
export function applySignedUrls(
  uploads: BriefUpload[],
  signed: Map<string, string>,
): BriefUpload[] {
  return uploads.map((u) => ({ ...u, url: signed.get(u.url) ?? '' }))
}

/**
 * Sign a brief's uploaded materials. Reads the paths off the (unsigned) uploads,
 * mints signed URLs against the shared wizard bucket, and returns uploads whose
 * `url` is now a signed URL (or '' when unsignable). Bucket-agnostic signing
 * lives in `createSignedUrlMap`, so this stays a thin wizard-specific wrapper.
 */
export async function signBriefUploads(
  uploads: BriefUpload[],
  ttlSeconds?: number,
): Promise<BriefUpload[]> {
  if (uploads.length === 0) return uploads
  const map = await createSignedUrlMap(WIZARD_UPLOAD_BUCKET, uploads.map((u) => u.url), ttlSeconds)
  return applySignedUrls(uploads, map)
}
