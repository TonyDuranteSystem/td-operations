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
