/**
 * Portal document upload path rules (security hunt 2026-10-25).
 *
 * `POST /api/portal/documents/upload-url` mints `<accountId>/<uuid>.<ext>` in the private `portal-uploads` bucket; the JSON mode of
 * `POST /api/portal/documents/upload` then downloads and DELETES whatever `storage_path` the caller names. Without a prefix check a
 * client of company A could name company B's staged object. And an extension taken as `file_name.split('.').pop()` can contain "/".
 */

/** The staged object must live under the caller's own account folder, directly (no sub-folders, no traversal). */
export function isOwnStagedUploadPath(accountId: unknown, storagePath: unknown): boolean {
  if (typeof accountId !== 'string' || typeof storagePath !== 'string' || !accountId || accountId.includes('/') || accountId.includes('..')) return false
  const prefix = `${accountId}/`
  if (!storagePath.startsWith(prefix)) return false
  const rest = storagePath.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/') && !rest.includes('..') && !rest.includes('\\') && storagePath.length <= 512
}

/** A safe file extension for the staged object name: letters/digits only, at most 10 characters; anything else → the fallback. */
export function safeUploadExtension(fileName: unknown, fallback = 'pdf'): string {
  if (typeof fileName !== 'string') return fallback
  const i = fileName.lastIndexOf('.')
  if (i < 0) return fallback
  const ext = fileName.slice(i + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : fallback
}
