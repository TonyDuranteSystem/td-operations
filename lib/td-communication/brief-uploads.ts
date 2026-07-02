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
 * Path prefixes a brand-audit brief may surface. The td_communication wizard
 * writes uploads as `td_communication/<id>/…` (the path-minter uses the wizard
 * type as the first segment, falling back to `wizard/` when it's absent).
 *
 * Deliberately NOT the shared `WIZARD_UPLOAD_PREFIXES` from wizard-uploads.ts:
 * that list OMITS `td_communication/` (it would reject the very paths we need)
 * AND is load-bearing for the Drive/passport sweep (`collectUploadPaths`), so
 * reusing or extending it here would be both wrong and a cross-feature side
 * effect.
 */
const BRIEF_UPLOAD_PREFIXES = ['td_communication/', 'wizard/'] as const

/**
 * Defense-in-depth (security): only mint a signed URL for a path that looks like
 * a legitimate brand-audit upload. `onboarding-uploads` is a SHARED bucket that
 * also holds passports / SSNs / tax returns, and an EXTERNAL partner (Cris)
 * consumes this brief — so we never hand out a signed URL for an arbitrary
 * bucket path. Paths come from server-read form_data (no client input), so this
 * is belt-and-suspenders against a future mis-seeded row / form_data injection,
 * not a live hole. A rejected path is simply not signed → the UI renders it as
 * "(unavailable)".
 */
export function isSignableUploadPath(path: string): boolean {
  if (typeof path !== 'string') return false
  const p = path.trim()
  if (!p || p.includes('..')) return false
  return BRIEF_UPLOAD_PREFIXES.some((prefix) => p.startsWith(prefix))
}

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
  // Only sign paths that pass the allow-list; disallowed ones aren't signed and
  // fall through to '' (unavailable) in applySignedUrls.
  const signablePaths = uploads.map((u) => u.url).filter(isSignableUploadPath)
  const map = await createSignedUrlMap(WIZARD_UPLOAD_BUCKET, signablePaths, ttlSeconds)
  return applySignedUrls(uploads, map)
}
