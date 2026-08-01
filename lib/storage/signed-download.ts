/**
 * Signed-download helper — hand a client a short-lived link to the EXACT file we
 * recorded for them, never "the newest file in the folder".
 *
 * Why this exists (security, dev_task 97177e49): the signed-contracts / signed-leases
 * buckets used to be readable by the anon key, and the client pages downloaded by
 * LISTING the token's folder and taking the highest-sorting name. With anon INSERT
 * still permitted, an attacker could POST `{token}/zzz.pdf` into the folder and the
 * victim's re-download would serve the attacker's file (content injection of a legal
 * document). Signing the DB-recorded path closes that: the path comes from the
 * contract/lease row, not from a folder listing, so a planted object is unreachable.
 *
 * `normalizeStoragePath` is pure so it can be unit-tested without a storage client.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Validate + normalize a recorded storage path. Returns null (fail-closed) for
 * anything empty, non-string, or containing a parent-directory traversal. A leading
 * slash is stripped (Supabase paths are bucket-relative). NEVER returns a path we'd
 * refuse to sign.
 */
export function normalizeStoragePath(recordedPath: string | null | undefined): string | null {
  if (typeof recordedPath !== "string") return null
  const path = recordedPath.replace(/^\/+/, "").trim()
  if (!path) return null
  // No traversal, no absolute escape. Recorded paths are always `${token}/<file>`.
  if (path.includes("..") || path.includes("\\")) return null
  return path
}

/**
 * Mint a short-lived signed URL for the recorded path in `bucket`, or null if the
 * path is missing/invalid or the storage call fails. TTL defaults to 60s — long
 * enough for the browser to fetch the bytes, short enough that a leaked URL is
 * near-useless. Uses the service-role client (bypasses RLS by design: the caller
 * route has already verified the token/access-code).
 */
export async function createRecordedSignedUrl(
  bucket: string,
  recordedPath: string | null | undefined,
  ttlSeconds = 60,
): Promise<string | null> {
  const path = normalizeStoragePath(recordedPath)
  if (!path) return null
  try {
    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, ttlSeconds)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch {
    return null
  }
}
