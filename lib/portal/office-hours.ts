/**
 * Office hours utility for Tony Durante LLC.
 * Mon–Fri, 9 AM – 3 PM Eastern Time.
 *
 * Accepts an optional `now` argument so callers can pass a fixed Date in tests
 * without mocking system clock.
 */

const OFFICE_TZ = 'America/New_York'
const OFFICE_OPEN_HOUR = 9   // 9:00 AM
const OFFICE_CLOSE_HOUR = 15 // 3:00 PM (exclusive — 3:00 PM is already closed)

// Intl.DateTimeFormat is available in all Node.js versions we support.
const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TZ,
  weekday: 'short',  // Mon | Tue | Wed | Thu | Fri | Sat | Sun
  hour: 'numeric',
  hourCycle: 'h23',  // 0–23, no AM/PM ambiguity
})

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

/**
 * Returns true if `now` falls within office hours (Mon–Fri 9 AM–3 PM ET).
 * 9:00 AM is open; 3:00 PM (hour === 15) is already closed.
 */
export function isOfficeOpen(now: Date = new Date()): boolean {
  const parts = dtf.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)

  return WEEKDAYS.has(weekday) && hour >= OFFICE_OPEN_HOUR && hour < OFFICE_CLOSE_HOUR
}
