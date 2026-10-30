/**
 * TD Marketing — the free slots offered when a call is booked (server; dev job 9aec66fa, Addendum K, B5). The seller's busy time (his work calendar and his personal calendars, asked only "when is he
 * busy"), plus the calls already booked in Marketing, run through the ONE slot rule (free-slots.ts). The setter receives only the slot START TIMES, never what made a time busy. If a personal
 * calendar is shared wider than "free/busy only", or Google cannot answer, NO slot is offered (it never shows him as free): the answer says why and the screen shows a plain message.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { checkShare, googleApi, isWorkMailbox, shareOk, type GcalApi } from "@/lib/marketing/gcal"
import { loadCalendarData } from "@/lib/marketing/calendar-read"
import { freeSlots, slotDays, type Interval } from "@/lib/marketing/free-slots"
import { memberZone, resolveCallHours, type Taker, type TimePrefs } from "@/lib/marketing/time-prefs"

export interface SlotDay { key: string; slots: string[] }
export type SlotOffer =
  | { state: "ok"; sellerLabel: string; zone: string; days: SlotDay[] }
  | { state: "hidden"; sellerLabel: string; reason: "share" | "error" }

/** The offer from the busy intervals (pure): every working day in the window with its free slots (days with none are left out). */
export function buildSlotOffer(i: { prefs: TimePrefs; seller: Taker; nowMs: number; busy: readonly Interval[] }): SlotOffer {
  const hours = resolveCallHours(i.prefs.callHours[i.seller.userId])
  const zone = memberZone(i.prefs, i.seller.userId)
  const days = slotDays(i.nowMs, zone, hours)
    .map(key => ({ key, slots: freeSlots({ zone, day: key, hours, busy: i.busy, nowMs: i.nowMs }).map(ms => new Date(ms).toISOString()) }))
    .filter(d => d.slots.length > 0)
  return { state: "ok", sellerLabel: i.seller.label, zone, days }
}

export async function loadSlotOffer(i: { api?: GcalApi; db: Db; teamId: string; prefs: TimePrefs; seller: Taker | null; excludeLeadId: string; nowMs?: number }): Promise<SlotOffer | null> {
  if (!i.prefs.busyEnabled || !i.seller || !isWorkMailbox(i.seller.email)) return null
  const api = i.api ?? googleApi
  const nowMs = i.nowMs ?? Date.now()
  const hours = resolveCallHours(i.prefs.callHours[i.seller.userId])
  const toMs = nowMs + (hours.ahead + 2) * 86_400_000
  const personal = i.prefs.personalCalendars[i.seller.userId] ?? []
  const share = await checkShare(api, i.seller.email, personal)
  if (!shareOk(share)) return { state: "hidden", sellerLabel: i.seller.label, reason: share.some(r => r.state === "error") ? "error" : "share" }
  try {
    const ids = ["primary", ...personal]
    const fb = await api.freeBusy(i.seller.email, ids, new Date(nowMs).toISOString(), new Date(toMs).toISOString())
    if (ids.some(id => !fb[id] || fb[id].error)) return { state: "hidden", sellerLabel: i.seller.label, reason: "error" }
    const busy: Interval[] = ids.flatMap(id => fb[id].busy.map(b => ({ start: b.start, end: b.end })))
    // the calls already booked in Marketing hold their hour too (the lead's own call, when it is being moved, does not hold it against itself)
    const { appointments } = await loadCalendarData(i.db, i.teamId)
    for (const a of appointments) {
      const at = Date.parse(a.at)
      if (a.lead.id !== i.excludeLeadId && !Number.isNaN(at) && at >= nowMs - 3_600_000) busy.push({ start: at, end: at + hours.slot * 60_000 })
    }
    return buildSlotOffer({ prefs: i.prefs, seller: i.seller, nowMs, busy })
  } catch { return { state: "hidden", sellerLabel: i.seller.label, reason: "error" } }
}
