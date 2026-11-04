/**
 * Staff time zone — pure helpers for showing the WhatsApp Worker the SAME clock times the staff
 * member sees on screen.
 *
 * Why: the chat screen prints message times in the browser's local zone ("Sep 21, 09:49"), while the
 * Worker used to be handed UTC ("13:49 UTC") — four hours apart in summer — so a time quoted from the
 * screen never lined up with what the Worker saw (Antonio, 2026-11-04). The panel now sends its zone;
 * the server validates it and falls back to New York (the business zone) when it is missing or odd.
 */

export const DEFAULT_STAFF_TIME_ZONE = "America/New_York"

const ZONE_SHAPE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/

/** A usable IANA zone name from untrusted input, else the default. Never throws. */
export function resolveStaffTimeZone(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_STAFF_TIME_ZONE
  const zone = input.trim()
  if (!zone || zone.length > 64 || !ZONE_SHAPE.test(zone)) return DEFAULT_STAFF_TIME_ZONE
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return DEFAULT_STAFF_TIME_ZONE
  }
}

function partsOf(ms: number, tz: string, withZoneName: boolean): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(withZoneName ? { timeZoneName: "short" as const } : {}),
  })
  const out: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value
  return out
}

/** "2026-09-21 09:49 EDT" — a message time as the staff member's clock shows it. UTC input zone prints "… UTC". */
export function formatLocalStamp(iso: string | null, tz: string = "UTC"): string {
  const t = iso ? new Date(iso) : null
  if (!t || Number.isNaN(t.getTime())) return "time unknown"
  if (tz === "UTC") return `${t.toISOString().slice(0, 16).replace("T", " ")} UTC`
  const p = partsOf(t.getTime(), tz, true)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName ?? tz}`
}

/** "2026-09-21" — the calendar date of an instant in the given zone. */
export function formatLocalDate(iso: string | null, tz: string = "UTC"): string {
  return formatLocalStamp(iso, tz).slice(0, 10)
}

/** How far the zone is ahead of UTC at this instant, in milliseconds (EDT = -4h). */
function offsetMs(ms: number, tz: string): number {
  const whole = ms - (ms % 1000)
  const p = partsOf(whole, tz, false)
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asIfUtc - whole
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar date written YYYY-MM-DD. */
export function isValidYmd(ymd: string): boolean {
  const m = YMD.exec(ymd)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD. */
export function nextYmd(ymd: string): string {
  const m = YMD.exec(ymd)
  if (!m) return ymd
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10)
}

/** The instant a calendar day STARTS in the given zone (midnight there), as a UTC Date. Null when the date is not real. */
export function localDayStartUtc(ymd: string, tz: string): Date | null {
  if (!isValidYmd(ymd)) return null
  const m = YMD.exec(ymd) as RegExpExecArray
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0)
  const first = guess - offsetMs(guess, tz)
  // Re-measure at the candidate instant: across a daylight-saving change the offset differs by an hour.
  const second = guess - offsetMs(first, tz)
  return new Date(second)
}
