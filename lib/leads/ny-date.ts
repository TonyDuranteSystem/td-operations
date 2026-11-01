// New York calendar dates — the business clock for call dates. Pure.

import { todayInNewYork } from '@/lib/leads/list-filters'

/** New York calendar date (YYYY-MM-DD) of an ISO timestamp. */
export function nyDate(iso: string): string {
  return todayInNewYork(new Date(iso))
}

function toDayNumber(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000)
}

/** Whole days from one YYYY-MM-DD to another (negative when `toYmd` is earlier). */
export function daysBetween(fromYmd: string, toYmd: string): number {
  return toDayNumber(toYmd) - toDayNumber(fromYmd)
}
