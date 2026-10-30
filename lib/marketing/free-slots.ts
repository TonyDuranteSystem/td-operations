/**
 * TD Marketing — the seller's free slots (pure; dev job 9aec66fa, Addendum K, build step B5). Working hours in HIS zone, minus anything busy, minus the calls already booked, with a gap kept around each,
 * in slots of a set length on the half hour. This is the ONE place the rule lives, so switching to another source of availability later (Calendly's own) changes nothing on the screens. The setter
 * only ever receives the slot start times, never what made a time busy. No database and no network here.
 */
import { localToIso, zoneParts } from "@/lib/marketing/zones"
import type { CallHours } from "@/lib/marketing/time-prefs"

const MIN = 60_000
export interface Interval { start: number; end: number }

/** The weekday (0 = Sunday) of a "YYYY-MM-DD" key. */
const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
const addDays = (key: string, n: number): string => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The days (keys in the seller's zone) a slot may be offered: today and the next `ahead` days that are working days. */
export function slotDays(nowMs: number, zone: string, hours: CallHours): string[] {
  const today = zoneParts(nowMs, zone)?.key
  if (!today) return []
  return Array.from({ length: hours.ahead + 1 }, (_, i) => addDays(today, i)).filter(k => hours.days.includes(weekdayOf(k)))
}

/** The start (ms) of every free slot of one day (a key in the seller's zone), oldest first. A day he does not work, or a day that does not exist, has none. */
export function freeSlots(i: { zone: string; day: string; hours: CallHours; busy: readonly Interval[]; nowMs: number }): number[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.day) || !i.hours.days.includes(weekdayOf(i.day))) return []
  const pad = (n: number) => String(n).padStart(2, "0")
  const startIso = localToIso(`${i.day}T${pad(i.hours.start)}:00`, i.zone)
  const endIso = i.hours.end >= 24 ? localToIso(`${addDays(i.day, 1)}T00:00`, i.zone) : localToIso(`${i.day}T${pad(i.hours.end)}:00`, i.zone)
  if (!startIso || !endIso) return []
  const start = Date.parse(startIso), end = Date.parse(endIso)
  const len = i.hours.slot * MIN, gap = i.hours.gap * MIN
  const earliest = i.nowMs + i.hours.notice * MIN
  const blocked = i.busy.map(b => ({ start: b.start - gap, end: b.end + gap }))
  const out: number[] = []
  for (let t = start; t + len <= end; t += 30 * MIN) {
    if (t < earliest) continue
    if (blocked.some(b => t < b.end && t + len > b.start)) continue
    out.push(t)
  }
  return out
}
