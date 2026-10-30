/**
 * TD Marketing — time zones (pure and client-safe; dev job 9aec66fa, Addendum K, build step B1). Every time the workspace shows or reads is an absolute instant; what changes from person to
 * person is the ZONE it is read in: Antonio in New York, Rocco in the Canary Islands, a lead wherever the lead lives. A zone is a real zone name ("Atlantic/Canary"), never an offset, so the
 * clock changes of the US (second Sunday of March, first Sunday of November) and of Europe (last Sundays of March and October) come out right by themselves. No DOM, no database.
 */

/** The zone every Marketing screen used before zones were added; still the built-in starting value for anybody whose zone is not set. */
export const ROME = "Europe/Rome"

const cache = new Map<string, Intl.DateTimeFormat>()
function dtf(zone: string): Intl.DateTimeFormat {
  let f = cache.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    cache.set(zone, f)
  }
  return f
}

/** True for a zone name the runtime knows ("Europe/Rome", "Atlantic/Canary", "UTC"). */
export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length < 3 || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return false
  try { dtf(zone); return true } catch { return false }
}

export interface ZoneParts { /** "YYYY-MM-DD" in the zone */ key: string; y: number; mo: number; d: number; h: number; m: number }

/** The day and wall-clock time of an instant in a zone, or null when it is not a date. */
export function zoneParts(at: Date | string | number, zone: string): ZoneParts | null {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const p = Object.fromEntries(dtf(zone).formatToParts(d).map(x => [x.type, x.value])) as Record<string, string>
  return { key: `${p.year}-${p.month}-${p.day}`, y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, m: Number(p.minute) }
}

/** How many minutes the zone is ahead of UTC at this instant (Rome: 60 in winter, 120 in summer; New York: -300 or -240). */
export function offsetMinutes(at: Date, zone: string): number {
  const p = Object.fromEntries(dtf(zone).formatToParts(at).map(x => [x.type, x.value])) as Record<string, string>
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return Math.round((asUtc - at.getTime() + at.getMilliseconds()) / 60000)
}

/** "UTC+1", "UTC-5", "UTC+5:30": the zone's offset at this instant, for showing next to a clock. */
export function utcOffsetText(at: Date | string | number, zone: string): string {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ""
  const o = offsetMinutes(d, zone)
  const a = Math.abs(o)
  return `UTC${o < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** "16:05": the wall clock in a zone. */
export function clockText(at: Date | string | number, zone: string): string {
  const p = zoneParts(at, zone)
  return p ? `${pad(p.h)}:${pad(p.m)}` : "--:--"
}

/** "2026-11-03T16:05": a value for a date-and-time field, read in the zone. */
export function isoToLocal(iso: string, zone: string): string {
  const p = zoneParts(iso, zone)
  return p ? `${p.key}T${pad(p.h)}:${pad(p.m)}` : ""
}

/**
 * "2026-10-27T11:00" (a datetime-local value, read as wall-clock time IN THAT ZONE) -> the real instant as an ISO string; null when it is not a valid date. A date that does not exist
 * (month 13, 31 November, 25:00) is refused, and the offset is settled in two passes so a time around a clock change lands on the right instant.
 */
export function localToIso(local: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local).trim())
  if (!m || !isValidZone(zone)) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const g = new Date(guess)
  if (Number.isNaN(guess) || g.getUTCFullYear() !== y || g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d || g.getUTCHours() !== h || g.getUTCMinutes() !== mi) return null
  let t = guess - offsetMinutes(new Date(guess), zone) * 60000
  t = guess - offsetMinutes(new Date(t), zone) * 60000
  const out = new Date(t)
  return Number.isNaN(out.getTime()) ? null : out.toISOString()
}

/** Zones people are most often in; shown first in a zone list. A label is only a name for people to read. */
export const COMMON_ZONES: ReadonlyArray<{ zone: string; label: string }> = [
  { zone: "Europe/Rome", label: "Rome" },
  { zone: "Atlantic/Canary", label: "Canary Islands" },
  { zone: "America/New_York", label: "New York" },
  { zone: "Europe/London", label: "London" },
  { zone: "Europe/Madrid", label: "Madrid" },
  { zone: "Europe/Paris", label: "Paris" },
  { zone: "Europe/Berlin", label: "Berlin" },
  { zone: "America/Chicago", label: "Chicago" },
  { zone: "America/Denver", label: "Denver" },
  { zone: "America/Los_Angeles", label: "Los Angeles" },
  { zone: "America/Toronto", label: "Toronto" },
  { zone: "America/Sao_Paulo", label: "São Paulo" },
  { zone: "Asia/Dubai", label: "Dubai" },
]

/** A readable name for a zone: "Canary Islands", "New York", "Rome"; any other zone shows its city ("Buenos Aires"). */
export function zoneName(zone: string): string {
  const known = COMMON_ZONES.find(z => z.zone === zone)
  if (known) return known.label
  const last = zone.split("/").pop() ?? zone
  return last.replace(/_/g, " ")
}

/** Every zone name the runtime knows (the common ones when it cannot list them), sorted by name. */
export function allZones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone")
  const base = list && list.length ? list : COMMON_ZONES.map(z => z.zone)
  return Array.from(new Set([...COMMON_ZONES.map(z => z.zone), ...base]))
}

/** The options of a zone picker: the common zones first, then all the rest ("Buenos Aires · America"). */
export function zoneOptions(): Array<{ zone: string; label: string }> {
  const common = new Set(COMMON_ZONES.map(z => z.zone))
  const rest = allZones().filter(z => !common.has(z)).map(z => ({ zone: z, label: `${zoneName(z)} · ${z.split("/")[0]}` })).sort((a, b) => a.label.localeCompare(b.label))
  return [...COMMON_ZONES, ...rest]
}
