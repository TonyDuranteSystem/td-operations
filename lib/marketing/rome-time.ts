/**
 * TD Marketing — a day and time typed in a date field is ROME time (pure; dev job 9aec66fa). Every marketing screen shows Rome time, so "11:00" typed for a booked call or a call back must
 * mean 11:00 in Rome whatever time zone the computer is set to (Antonio and Rocco are not necessarily in Italy). No database here.
 */
const ROME = "Europe/Rome"
const PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

/** How many minutes Rome is ahead of UTC at this instant (60 in winter, 120 in summer). */
function romeOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(PARTS.formatToParts(at).map(x => [x.type, x.value])) as Record<string, string>
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return Math.round((asUtc - at.getTime() + at.getMilliseconds()) / 60000)
}

/** "2026-10-27T11:00" (a datetime-local value, read as Rome wall-clock time) -> the real instant as an ISO string; null when it is not a valid date. */
export function romeLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const g = new Date(guess)
  // a date that does not exist (month 13, 31 November, 25:00) rolls over silently in Date.UTC: only a date that reads back exactly is accepted
  if (Number.isNaN(guess) || g.getUTCFullYear() !== y || g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d || g.getUTCHours() !== h || g.getUTCMinutes() !== mi) return null
  // the offset can differ between the guess and the real instant around a clock change: settle it in two passes
  let t = guess - romeOffsetMinutes(new Date(guess)) * 60000
  t = guess - romeOffsetMinutes(new Date(t)) * 60000
  const out = new Date(t)
  return Number.isNaN(out.getTime()) ? null : out.toISOString()
}
