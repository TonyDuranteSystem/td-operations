/** Small pure formatters for flow Workspace components (kept out of .tsx so
 *  vitest's node environment can import them without a JSX transform). */

/** Whole days between a past ISO timestamp and now (clamped at 0). */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const diffMs = now.getTime() - then
  return Math.max(0, Math.floor(diffMs / 86_400_000))
}

/** Human-readable file size from a byte count, or null when unknown/invalid. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  // Whole numbers for bytes; one decimal for KB+ unless it rounds clean.
  const rounded = i === 0 ? value : Math.round(value * 10) / 10
  return `${rounded} ${units[i]}`
}

/** Short, locale-stable date label (e.g. "Jun 14, 2026") from an ISO string. */
export function formatUploadDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return null
  return t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
