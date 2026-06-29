/**
 * TD Communication — enrollment aggregate stats + filtering (pure, client-safe).
 *
 * Backs the Enrollments admin tab header. Deterministic: avg delivery time is
 * computed from stored timestamps only (created_at → metadata.delivered_at),
 * never from the wall clock, and excludes enrollments with no delivered_at so
 * the average is honest (and never divides by zero).
 */

import { isEnrollmentStatus } from './pipeline'
import type { CommEnrollment, EnrollmentStats, EnrollmentStatus } from './types'

const MS_PER_DAY = 86_400_000

/** Read metadata.delivered_at (ISO string) if present and valid. */
function deliveredAt(e: CommEnrollment): number | null {
  const raw = (e.metadata as Record<string, unknown> | null)?.delivered_at
  if (typeof raw !== 'string' || !raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

/**
 * Compute totals, per-status counts, and average delivery time (days).
 * avgDeliveryDays is null when no enrollment has a delivered_at timestamp.
 */
export function computeEnrollmentStats(enrollments: CommEnrollment[]): EnrollmentStats {
  const byStatus: Record<string, number> = {}
  const durations: number[] = []

  for (const e of enrollments) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1

    const delivered = deliveredAt(e)
    const created = e.created_at ? Date.parse(e.created_at) : NaN
    if (delivered !== null && !Number.isNaN(created) && delivered >= created) {
      durations.push((delivered - created) / MS_PER_DAY)
    }
  }

  const avgDeliveryDays =
    durations.length === 0
      ? null
      : Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10

  return { total: enrollments.length, byStatus, avgDeliveryDays }
}

/** Filter by status. An absent/empty/invalid status returns the full list. */
export function filterByStatus(
  enrollments: CommEnrollment[],
  status?: string | null,
): CommEnrollment[] {
  if (!status || !isEnrollmentStatus(status)) return enrollments
  const s = status as EnrollmentStatus
  return enrollments.filter((e) => e.status === s)
}
