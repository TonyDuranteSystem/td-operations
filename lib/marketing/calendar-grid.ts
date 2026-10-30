/**
 * TD Marketing — the Calendar's day, week, month and pipeline views (pure, safe to use in the browser; dev job 9aec66fa, round 2 step 2). Every day and hour is read in ONE zone, whatever time zone
 * the computer is set to: the viewer's own (Addendum K, 30 Oct 2026: Antonio in New York, Rocco in the Canary Islands, the setter in Rome). A day is a "YYYY-MM-DD" key read in that zone, an hour is
 * its wall clock. Every helper takes the zone and reads Rome when none is given, which is what the screens did before zones. (The names still say "rome" for the same reason.) No DOM and no
 * database, so every rule is tested.
 */
import { ROME, localToIso, zoneParts } from "@/lib/marketing/zones"

/** The hours the day and week grids show; a call outside them is listed in a strip above the grid. */
export const HOUR_FROM = 8
export const HOUR_TO = 21
/** a drop snaps to this many minutes */
export const SNAP_MINUTES = 15

export interface RomeParts { key: string; h: number; m: number }

/** The day and time of an instant in a zone (Rome by default), or null when it is not a date. */
export function romeParts(iso: string, zone: string = ROME): RomeParts | null {
  const p = zoneParts(iso, zone)
  return p ? { key: p.key, h: p.h, m: p.m } : null
}

const utcOf = (key: string): Date => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)) }
const keyOf = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`

export const addDays = (key: string, n: number): string => { const d = utcOf(key); d.setUTCDate(d.getUTCDate() + n); return keyOf(d) }
/** 0 = Monday … 6 = Sunday */
export const weekdayIndex = (key: string): number => (utcOf(key).getUTCDay() + 6) % 7
export const weekStart = (key: string): string => addDays(key, -weekdayIndex(key))
export const weekDays = (key: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart(key), i))
export const monthKey = (key: string): string => key.slice(0, 7)
/** The same day number in another month (the 31st lands on the last day of a shorter month). */
export function shiftMonth(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number)
  const first = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return keyOf(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))))
}
/** The 42 days (six Monday-first weeks) a month view shows. */
export function monthGrid(key: string): string[] {
  const first = `${monthKey(key)}-01`
  const start = weekStart(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/** The instant for a day and wall-clock time in a zone (Rome by default), or null when it does not exist. */
export const slotIso = (key: string, h: number, m: number, zone: string = ROME): string | null => localToIso(`${key}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, zone)

/** The same time of day on another day (a drag in the month view, or into Tomorrow). */
export function moveToDay(iso: string, key: string, zone: string = ROME): string | null {
  const p = romeParts(iso, zone)
  return p ? slotIso(key, p.h, p.m, zone) : null
}

/** A drop at `fraction` (0..1) of the way down the hour grid becomes a time snapped to 15 minutes, kept inside the grid. */
export function timeFromFraction(fraction: number): { h: number; m: number } {
  const span = (HOUR_TO - HOUR_FROM) * 60
  const mins = Math.min(span - SNAP_MINUTES, Math.max(0, Math.round((Math.min(1, Math.max(0, fraction)) * span) / SNAP_MINUTES) * SNAP_MINUTES))
  return { h: HOUR_FROM + Math.floor(mins / 60), m: mins % 60 }
}

export type Bucket = "late" | "today" | "tomorrow" | "week" | "later"
export const BUCKETS: readonly Bucket[] = ["late", "today", "tomorrow", "week", "later"]

/** Which pipeline group a call is in. "Late" = its time has passed; "This week" = the days after tomorrow up to Sunday. */
export function bucketOf(atIso: string, nowIso: string, zone: string = ROME): Bucket | null {
  const at = romeParts(atIso, zone)
  const now = romeParts(nowIso, zone)
  if (!at || !now) return null
  if (new Date(atIso).getTime() < new Date(nowIso).getTime()) return "late"
  if (at.key === now.key) return "today"
  if (at.key === addDays(now.key, 1)) return "tomorrow"
  return at.key <= addDays(weekStart(now.key), 6) ? "week" : "later"
}

/**
 * Where a card dropped on a group goes. Today and Tomorrow keep the time of day (a time already past today becomes the next full hour); This week and Later need a person to choose the
 * day, so a starting point is suggested. Late is a result, never a place to drop.
 */
export function bucketDrop(bucket: Bucket, atIso: string, nowIso: string, zone: string = ROME): { kind: "move"; at: string } | { kind: "choose"; suggest: string } | { kind: "refuse" } {
  const now = romeParts(nowIso, zone)
  if (!now || bucket === "late") return { kind: "refuse" }
  if (bucket === "today") {
    const same = moveToDay(atIso, now.key, zone)
    if (same && new Date(same).getTime() > new Date(nowIso).getTime()) return { kind: "move", at: same }
    const next = slotIso(now.key, now.h + 1, 0, zone)
    if (next) return { kind: "move", at: next }
    // late in the evening there is no hour left today: let the person choose, starting tomorrow
    const tomorrow = moveToDay(atIso, addDays(now.key, 1), zone)
    return tomorrow ? { kind: "choose", suggest: tomorrow } : { kind: "refuse" }
  }
  if (bucket === "tomorrow") { const t = moveToDay(atIso, addDays(now.key, 1), zone); return t ? { kind: "move", at: t } : { kind: "refuse" } }
  const target = bucket === "week" ? (addDays(now.key, 2) <= addDays(weekStart(now.key), 6) ? addDays(now.key, 2) : addDays(weekStart(now.key), 6)) : addDays(now.key, 8)
  const t = moveToDay(atIso, target, zone)
  return t ? { kind: "choose", suggest: t } : { kind: "refuse" }
}

/** A value for a date-and-time field (in a zone, Rome by default) from an instant: "2026-10-27T11:00". */
export function romeLocalValue(iso: string, zone: string = ROME): string {
  const p = romeParts(iso, zone)
  return p ? `${p.key}T${String(p.h).padStart(2, "0")}:${String(p.m).padStart(2, "0")}` : ""
}

export interface Placed { index: number; top: number; lane: number; lanes: number }
/** Place the calls of one day on the hour grid: `top` is hours from the first hour; calls that start close together sit side by side (a lane each). Calls outside the grid are left out. */
export function layoutDay(starts: ReadonlyArray<{ h: number; m: number }>, overlapMinutes = 40): Placed[] {
  const items = starts.map((s, index) => ({ index, mins: s.h * 60 + s.m })).filter(i => i.mins >= HOUR_FROM * 60 && i.mins < HOUR_TO * 60).sort((a, b) => a.mins - b.mins)
  const out: Placed[] = []
  let cluster: Placed[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []
  const flush = () => { const lanes = laneEnds.length || 1; cluster.forEach(c => { c.lanes = lanes }); out.push(...cluster); cluster = []; laneEnds = [] }
  for (const it of items) {
    if (cluster.length && it.mins >= clusterEnd) flush()
    let lane = laneEnds.findIndex(e => e <= it.mins)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0) }
    laneEnds[lane] = it.mins + overlapMinutes
    clusterEnd = cluster.length ? Math.max(clusterEnd, it.mins + overlapMinutes) : it.mins + overlapMinutes
    cluster.push({ index: it.index, top: it.mins / 60 - HOUR_FROM, lane, lanes: 1 })
  }
  if (cluster.length) flush()
  return out
}
