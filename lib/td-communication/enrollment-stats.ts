/**
 * TD Communication — enrollment aggregate stats + filtering (pure, client-safe).
 *
 * Backs the Enrollments admin tab header. Deterministic: avg delivery time is
 * computed from stored timestamps only (created_at → metadata.delivered_at),
 * never from the wall clock, and excludes enrollments with no delivered_at so
 * the average is honest (and never divides by zero).
 */

import { isEnrollmentStatus, isSlaTracked, slaIndicator, daysRemaining } from './pipeline'
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
 * Compute totals, per-status counts, average delivery time, SLA compliance %,
 * and current overdue count.
 *
 * - avgDeliveryDays: null when no enrollment has a delivered_at timestamp.
 * - slaCompliancePct: % of delivered-with-a-deadline-and-delivered_at projects
 *   that were delivered on time (delivered calendar-day ≤ deadline calendar-day,
 *   so a delivery a few hours past midnight isn't counted late); null when none
 *   qualify.
 * - overdueCount: SLA-tracked (non-terminal) projects currently past deadline;
 *   needs `now`, so it is the only time-dependent stat (kept deterministic by
 *   taking `now` as an argument rather than reading the clock).
 */
export function computeEnrollmentStats(enrollments: CommEnrollment[], now: Date): EnrollmentStats {
  const byStatus: Record<string, number> = {}
  const durations: number[] = []
  let deliveredWithSla = 0
  let deliveredOnTime = 0
  let overdueCount = 0

  for (const e of enrollments) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1

    const delivered = deliveredAt(e)
    const created = e.created_at ? Date.parse(e.created_at) : NaN
    if (delivered !== null && !Number.isNaN(created) && delivered >= created) {
      durations.push((delivered - created) / MS_PER_DAY)
    }

    // SLA compliance: only delivered projects that had a deadline AND a
    // delivered_at can be judged on-time-or-late.
    if (e.status === 'delivered' && e.deadline && delivered !== null) {
      deliveredWithSla++
      const slack = daysRemaining(e.deadline, new Date(delivered))
      if (slack !== null && slack >= 0) deliveredOnTime++
    }

    // Overdue: in-flight projects whose deadline has passed.
    if (isSlaTracked(e.status) && slaIndicator(e.deadline, now) === 'red') overdueCount++
  }

  const avgDeliveryDays =
    durations.length === 0
      ? null
      : Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10

  const slaCompliancePct =
    deliveredWithSla === 0 ? null : Math.round((deliveredOnTime / deliveredWithSla) * 100)

  return { total: enrollments.length, byStatus, avgDeliveryDays, slaCompliancePct, overdueCount }
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
