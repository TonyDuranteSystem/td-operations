/**
 * Office hours utility for Tony Durante LLC.
 * Mon–Fri, 9 AM – 3 PM Eastern Time, excluding U.S. federal holidays.
 *
 * Eastern Time is the office timezone (the company is in Largo, FL — Pinellas
 * County / Tampa Bay, which is Eastern, not Central). The browser/Node `Intl`
 * formatter handles the EST↔EDT daylight-saving switch automatically.
 *
 * Accepts an optional `now` argument so callers can pass a fixed Date in tests
 * without mocking the system clock.
 */

export const OFFICE_TZ = 'America/New_York'
export const OFFICE_OPEN_HOUR = 9   // 9:00 AM
export const OFFICE_CLOSE_HOUR = 15 // 3:00 PM (exclusive — 3:00 PM is already closed)

// weekday + hour, in office timezone.
const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TZ,
  weekday: 'short', // Mon | Tue | Wed | Thu | Fri | Sat | Sun
  hour: 'numeric',
  hourCycle: 'h23', // 0–23, no AM/PM ambiguity
})

// Calendar date (Y-M-D) in office timezone — used for the holiday lookup so the
// "what day is it in the office?" question is answered in ET, not UTC.
const dateDtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: OFFICE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

/**
 * Today's calendar date (`YYYY-MM-DD`) in the office's own timezone (ET), not
 * the server/browser's UTC clock. `new Date().toISOString().split('T')[0]`
 * reads tomorrow's date for the last ~4-5 hours of the ET business day —
 * every invoice-dating call site in the billing engine must use this instead
 * (dev job ea5751ef, council review of dev job 4a854806).
 */
export function getOfficeDateString(now: Date = new Date()): string {
  return dateDtf.format(now)
}

export type OfficeClosedReason =
  | 'open'
  | 'before_hours'
  | 'after_hours'
  | 'weekend'
  | 'holiday'

export interface OfficeStatus {
  open: boolean
  reason: OfficeClosedReason
}

// ─── U.S. federal holidays ───────────────────────────────────────────────────

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** ISO weekday helper on a UTC-noon date (avoids DST edge cases). */
function utcNoon(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day, 12, 0, 0))
}

/** Date of the nth (1-based) given weekday in a month. weekday: 0=Sun … 6=Sat. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): number {
  const first = utcNoon(year, month1, 1).getUTCDay()
  const offset = (weekday - first + 7) % 7
  return 1 + offset + (n - 1) * 7
}

/** Date of the last given weekday in a month. */
function lastWeekday(year: number, month1: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate()
  const lastDow = utcNoon(year, month1, daysInMonth).getUTCDay()
  const offset = (lastDow - weekday + 7) % 7
  return daysInMonth - offset
}

/**
 * Apply the federal "observed" shift to a fixed-date holiday:
 * Saturday → observed the preceding Friday; Sunday → observed the following Monday.
 * Returns the observed date as a `YYYY-MM-DD` string.
 */
function observed(year: number, month1: number, day: number): string {
  const dow = utcNoon(year, month1, day).getUTCDay()
  const d = utcNoon(year, month1, day)
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1) // Sat → Fri
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1) // Sun → Mon
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function fixed(year: number, month1: number, day: number): string {
  return observed(year, month1, day)
}

function floating(year: number, month1: number, weekday: number, n: number): string {
  return `${year}-${pad(month1)}-${pad(nthWeekday(year, month1, weekday, n))}`
}

const holidayCache = new Map<number, Set<string>>()

/** Set of observed U.S. federal holiday dates (`YYYY-MM-DD`, ET calendar) for a year. */
export function usFederalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const set = new Set<string>([
    fixed(year, 1, 1), // New Year's Day
    floating(year, 1, 1, 3), // MLK Jr. Day — 3rd Mon Jan
    floating(year, 2, 1, 3), // Washington's Birthday — 3rd Mon Feb
    `${year}-05-${pad(lastWeekday(year, 5, 1))}`, // Memorial Day — last Mon May
    fixed(year, 6, 19), // Juneteenth
    fixed(year, 7, 4), // Independence Day
    floating(year, 9, 1, 1), // Labor Day — 1st Mon Sep
    floating(year, 10, 1, 2), // Columbus Day — 2nd Mon Oct
    fixed(year, 11, 11), // Veterans Day
    floating(year, 11, 4, 4), // Thanksgiving — 4th Thu Nov
    fixed(year, 12, 25), // Christmas Day
  ])
  holidayCache.set(year, set)
  return set
}

/** True if `now` falls on an observed U.S. federal holiday (ET calendar). */
export function isOfficeHoliday(now: Date = new Date()): boolean {
  const key = dateDtf.format(now) // en-CA → "YYYY-MM-DD"
  const year = parseInt(key.slice(0, 4), 10)
  return usFederalHolidays(year).has(key)
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Full open/closed status with the reason it's closed — drives the portal clock
 * and (via isOfficeOpen) the chat out-of-office auto-reply.
 */
export function getOfficeStatus(now: Date = new Date()): OfficeStatus {
  const parts = dtf.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)

  if (isOfficeHoliday(now)) return { open: false, reason: 'holiday' }
  if (!WEEKDAYS.has(weekday)) return { open: false, reason: 'weekend' }
  if (hour < OFFICE_OPEN_HOUR) return { open: false, reason: 'before_hours' }
  if (hour >= OFFICE_CLOSE_HOUR) return { open: false, reason: 'after_hours' }
  return { open: true, reason: 'open' }
}

/**
 * Returns true if `now` falls within office hours
 * (Mon–Fri 9 AM–3 PM ET, excluding U.S. federal holidays).
 */
export function isOfficeOpen(now: Date = new Date()): boolean {
  return getOfficeStatus(now).open
}
