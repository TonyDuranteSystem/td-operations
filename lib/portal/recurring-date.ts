/**
 * Next run date of a client's recurring sales invoice (dev job 1a23f5f1).
 *
 * Pure and month-end safe. The old cron used `setMonth(+1)`, which turns Jan 31 into Mar 3 and then keeps
 * drifting (Apr 3, May 3, ...). Here the day is CLAMPED to the last day of the target month, and the cycle
 * is always computed from the ORIGINAL anchor day, so a Jan 31 monthly invoice runs Jan 31, Feb 28, Mar 31.
 */

export type RecurringFrequency = 'monthly' | 'quarterly' | 'yearly'

const MONTHS: Record<RecurringFrequency, number> = { monthly: 1, quarterly: 3, yearly: 12 }

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!mt) return null
  const y = Number(mt[1]), m = Number(mt[2]), d = Number(mt[3])
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * `from` is the date of the cycle that just ran (or the first issue date). `anchorDay` is the day-of-month the
 * schedule started on (defaults to `from`'s own day); passing it keeps a Jan 31 schedule on the 31st after a
 * short February. Returns null for an unparseable date (the caller must treat that as an error, not a default).
 */
export function nextRecurringDate(from: string, frequency: RecurringFrequency, anchorDay?: number): string | null {
  const p = parseYmd(from)
  if (!p) return null
  const step = MONTHS[frequency]
  if (!step) return null
  const total = p.y * 12 + (p.m - 1) + step
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  const wanted = anchorDay && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : p.d
  return fmt(y, m, Math.min(wanted, daysInMonth(y, m)))
}

/** Whole days between two YYYY-MM-DD dates (b - a). Null when either is invalid. */
export function daysBetween(a: string, b: string): number | null {
  const pa = parseYmd(a), pb = parseYmd(b)
  if (!pa || !pb) return null
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000)
}

/** YYYY-MM-DD plus N days (UTC arithmetic on a calendar date, no timezone drift). */
export function addDaysYmd(ymd: string, days: number): string | null {
  const p = parseYmd(ymd)
  if (!p) return null
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000)
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}
