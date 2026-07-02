/**
 * Generic Supabase Storage signing primitive (server-only, service role).
 *
 * Private buckets store PATHS, not URLs — a raw path is not fetchable from the
 * browser. Anything that surfaces a stored file to the UI must mint a short-lived
 * signed URL first. This is the single reusable helper for that: bucket-agnostic,
 * knows nothing about wizards, deliverables, or TD Communication.
 *
 * Precedent hand-rolled the same `createSignedUrls` batch call in the deliverables
 * and disclaimer layers (which additionally need per-file forced-download names,
 * so they stay as-is). This extracts the common case — "sign a set of paths, get a
 * path→url map back" — so a third consumer (the creative brief's uploaded
 * materials) doesn't copy it a third time.
 *
 * Server-only: imports `supabaseAdmin` (service role). Never import into a client
 * bundle.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

/** Sensible default lifetime for a signed link surfaced in an internal panel. */
export const DEFAULT_SIGNED_URL_TTL = 60 * 60 * 6 // 6 hours

/**
 * Mint signed URLs for a set of storage paths in one bucket, returned as a
 * path→signedUrl map. Deduplicates, ignores empty/non-string paths, and omits
 * any path storage couldn't sign (deleted object, bad path) so the caller can
 * render those as "unavailable" rather than a broken link. Returns an empty map
 * when there is nothing to sign. Throws only on an unexpected storage error —
 * callers that must never fail the surrounding read should try/catch.
 */
export async function createSignedUrlMap(
  bucket: string,
  paths: Array<string | null | undefined>,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  const unique = Array.from(
    new Set(paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)),
  )
  const map = new Map<string, string>()
  if (unique.length === 0) return map

  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrls(unique, ttlSeconds)
  if (error) throw new Error(error.message)
  if (Array.isArray(data)) {
    for (const d of data) {
      if (d?.path && d?.signedUrl) map.set(d.path, d.signedUrl)
    }
  }
  return map
}
