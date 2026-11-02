/**
 * TD Marketing — the times offered for a call with BOTH the seller and the owner (pure; dev job 0b916784, 1 Nov 2026). The seller's free slots come from the ONE slot rule (free-slots.ts: his hours, his
 * busy time, the gap); each of those slots is then kept only if the owner is free for the same time too: inside his own hours (his zone, minutes after midnight), after his shortest notice, and not on
 * top of anything busy in his calendar (with the same gap). The client only ever receives the START TIMES, never what made a time unavailable. No database and no network here.
 */
import { freeSlots, slotDays, type Interval } from "@/lib/marketing/free-slots"
import { localToIso, zoneParts } from "@/lib/marketing/zones"
import type { CallHours } from "@/lib/marketing/time-prefs"
import type { OwnerCallHours } from "@/lib/marketing/settings-schema"

const MIN = 60_000

export interface OwnerSide { zone: string; hours: OwnerCallHours; busy: readonly Interval[] }

/** Is the owner free for [start, end) (ms)? Inside his hours on one of his working days, after his notice, clear of every busy block by `gapMin`. */
export function ownerFree(startMs: number, endMs: number, o: OwnerSide, gapMin: number, nowMs: number): boolean {
  if (startMs < nowMs + o.hours.notice * MIN) return false
  const sp = zoneParts(startMs, o.zone), ep = zoneParts(endMs - 1, o.zone)
  if (!sp || !ep || sp.key !== ep.key) return false // a call that crosses his midnight is never inside his working day
  const weekday = new Date(`${sp.key}T12:00:00Z`).getUTCDay()
  if (!o.hours.days.includes(weekday)) return false
  const pad = (n: number) => String(n).padStart(2, "0")
  const at = (min: number) => localToIso(`${sp.key}T${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`, o.zone)
  const from = at(o.hours.startMin)
  // 24:00 is the start of the next day
  const to = o.hours.endMin >= 1440 ? localToIso(`${new Date(Date.parse(`${sp.key}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00`, o.zone) : at(o.hours.endMin)
  if (!from || !to) return false
  if (startMs < Date.parse(from) || endMs > Date.parse(to)) return false
  const gap = gapMin * MIN
  return !o.busy.some(b => startMs < b.end + gap && endMs > b.start - gap)
}

/** Every start (ms) at which the seller and the owner are both free, oldest first. */
export function jointSlots(i: { sellerZone: string; sellerHours: CallHours; sellerBusy: readonly Interval[]; owner: OwnerSide; nowMs: number }): number[] {
  const len = i.sellerHours.slot * MIN
  const out: number[] = []
  for (const day of slotDays(i.nowMs, i.sellerZone, i.sellerHours)) {
    for (const t of freeSlots({ zone: i.sellerZone, day, hours: i.sellerHours, busy: i.sellerBusy, nowMs: i.nowMs })) {
      if (ownerFree(t, t + len, i.owner, i.sellerHours.gap, i.nowMs)) out.push(t)
    }
  }
  return out
}

/** Is this one start still offered right now (the re-check when somebody confirms)? The same rule as the list, for one time. */
export function jointSlotStillFree(startMs: number, i: { sellerZone: string; sellerHours: CallHours; sellerBusy: readonly Interval[]; owner: OwnerSide; nowMs: number }): boolean {
  return jointSlots(i).includes(startMs)
}
