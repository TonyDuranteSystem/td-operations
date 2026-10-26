/**
 * TD Marketing — the Calendar (pure; dev job 9aec66fa, build step 5). An agenda by day of the call backs: the leads where somebody pressed "Call back later" with a date and time.
 * Whose call back is it: the person who set it (the actor of the lead's latest "call back" history row); if somebody has picked the lead since, it is the picker's. A call back whose
 * setter is not a member of the team (Antonio looking in with "View as") belongs to nobody: it shows in "Everyone" only. No database here.
 */
import { personName } from "@/lib/marketing/setter-note"
import { localeFor, makeT, type TFn } from "@/lib/marketing/i18n"
import type { Lang } from "@/lib/marketing/templates"
import { ageText, romeStartOfDay, romeStartOfNextDay } from "@/lib/marketing/master-view"

export interface CalLead { id: string; full_name: string | null; email: string | null; ad_name: string | null; claimed_by: string | null; callback_at: string | null; status?: string }
/** The history rows that set a call back: kind status_changed with outcome call_back. */
export interface CalEvent { lead_id: string; actor: string; created_at: string; data: Record<string, unknown> }
export interface CalMember { user_id: string; email: string | null; status?: string }

/** A call booked with the seller (the newest "appointment" row of a lead that is not cancelled). */
export interface CalAppointment { lead: Pick<CalLead, "id" | "full_name" | "email" | "ad_name" | "claimed_by" | "status">; at: string; actor: string }

export interface CalItem {
  /** "callback" = the setter promised to call back; "appointment" = a call booked with the seller */
  kind: "callback" | "appointment"
  leadId: string
  name: string
  at: string
  /** HH:MM in Rome */
  time: string
  ad: string | null
  /** "Tue 20 Oct" in Rome */
  dateLabel: string
  /** "3 h late", "2 d late"; null when it is not late */
  lateBy: string | null
  /** the owner's user id, or null = nobody (setter not on the team) */
  ownerId: string | null
  /** who set it, as a name; null when the history has no row for it */
  setBy: string | null
  /** true when the person who set it is on the team (false: Antonio looking in, a removed member, or nobody recorded) */
  setByMember: boolean
  late: boolean
}
export interface CalDay { key: string; label: string; items: CalItem[] }
export interface Agenda { late: CalItem[]; lateMore: number; days: CalDay[]; beyond: number }
/** how many late call backs are listed (the most overdue first); the rest are counted */
export const LATE_SHOWN = 50

const ROME = "Europe/Rome"
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, hour: "2-digit", minute: "2-digit", hour12: false })
const fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, weekday: "short", day: "numeric", month: "short" })
const fmtZone = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, timeZoneName: "short" })
/** "CEST" or "CET": the Rome clock in force at this moment. */
export const romeZoneName = (d: Date): string => (fmtZone.formatToParts(d).find(p => p.type === "timeZoneName")?.value ?? "Rome time")
const fmtKey = new Intl.DateTimeFormat("en-CA", { timeZone: ROME, year: "numeric", month: "2-digit", day: "2-digit" })
export const romeTime = (iso: string): string => fmtTime.format(new Date(iso))
export const romeDayKey = (d: Date): string => fmtKey.format(d)
export const romeDayLabel = (d: Date, lang: Lang = "en"): string => (lang === "en" ? fmtDay : new Intl.DateTimeFormat(localeFor(lang), { timeZone: ROME, weekday: "short", day: "numeric", month: "short" })).format(d).replace(",", "").replace(/\.$/, "")

/** Who set each lead's current call back: the actor of the lead's NEWEST "call back" or "not ready now" row, a View-as row included (if Antonio changed the time while looking in, it is his, not the earlier setter's). Returns the actor's email. */
export function latestSetters(events: readonly CalEvent[]): Map<string, { actor: string; at: string }> {
  const out = new Map<string, { actor: string; at: string }>()
  for (const e of events) {
    if (e.data?.outcome !== "call_back" && e.data?.outcome !== "not_ready") continue
    const cur = out.get(e.lead_id)
    if (!cur || e.created_at > cur.at) out.set(e.lead_id, { actor: e.actor, at: e.created_at })
  }
  return out
}

/** The owner of a call back: whoever picked the lead; otherwise the team member whose email set it; otherwise nobody. */
export function callBackOwner(lead: Pick<CalLead, "claimed_by">, setterEmail: string | null, members: readonly CalMember[]): string | null {
  if (lead.claimed_by) return lead.claimed_by
  if (!setterEmail) return null
  const m = members.find(x => x.email !== null && x.email.toLowerCase() === setterEmail.toLowerCase() && x.status !== "removed")
  return m?.user_id ?? null
}

/**
 * The agenda for one person (`ownerId`) or for everyone (`ownerId` = "all"): the late ones first, then each day from today for `days` days (days with nothing are left out), and how many
 * call backs lie beyond the window. A call back is "late" when its time has passed.
 */
export function buildAgenda(i: {
  leads: readonly CalLead[]; events: readonly CalEvent[]; members: readonly CalMember[]
  /** a user id, or "all" */
  ownerId: string
  now: Date; days: number
  /** calls booked with the seller; only the ones still ahead are listed */
  appointments?: readonly CalAppointment[]
  /** the language of the day names and "3 h late" (default English) */
  lang?: Lang
}): Agenda {
  const lang: Lang = i.lang ?? "en"
  const t = makeT(lang)
  const dayUnit = lang === "it" ? "g" : "d"
  const nowMs = i.now.getTime()
  const setters = latestSetters(i.events)
  const windowEnd = (() => { let d = romeStartOfDay(i.now); for (let k = 0; k < i.days; k++) d = romeStartOfNextDay(d); return d.getTime() })()
  const items: CalItem[] = []
  let beyond = 0
  for (const l of i.leads) {
    if (!l.callback_at) continue
    const setter = setters.get(l.id)?.actor ?? null
    const ownerId = callBackOwner(l, setter, i.members)
    if (i.ownerId !== "all" && ownerId !== i.ownerId) continue
    const at = new Date(l.callback_at).getTime()
    if (!(at < windowEnd)) { beyond++; continue }
    items.push({
      kind: "callback", leadId: l.id, name: l.full_name || l.email || t("Unnamed lead"), at: l.callback_at, time: romeTime(l.callback_at), ad: l.ad_name, dateLabel: romeDayLabel(new Date(l.callback_at), lang),
      lateBy: at < nowMs ? t("{age} late", { age: ageText(nowMs - at, dayUnit) }) : null, ownerId,
      setByMember: setter !== null && i.members.some(m => m.email !== null && m.email.toLowerCase() === setter.toLowerCase() && m.status !== "removed"),
      setBy: setter ? personName(setter) : null, late: at < nowMs,
    })
  }
  for (const a of i.appointments ?? []) {
    const at = new Date(a.at).getTime()
    if (Number.isNaN(at) || at < nowMs) continue // a call that has happened is history, not agenda
    const ownerId = callBackOwner(a.lead, a.actor, i.members)
    if (i.ownerId !== "all" && ownerId !== i.ownerId) continue
    if (!(at < windowEnd)) { beyond++; continue }
    items.push({
      kind: "appointment", leadId: a.lead.id, name: a.lead.full_name || a.lead.email || t("Unnamed lead"), at: a.at, time: romeTime(a.at), ad: a.lead.ad_name, dateLabel: romeDayLabel(new Date(a.at), lang),
      lateBy: null, ownerId, setByMember: i.members.some(m => m.email !== null && m.email.toLowerCase() === a.actor.toLowerCase() && m.status !== "removed"), setBy: personName(a.actor), late: false,
    })
  }
  items.sort((a, b) => a.at.localeCompare(b.at))
  const lateAll = items.filter(x => x.late)
  const late = lateAll.slice(0, LATE_SHOWN)
  const byDay = new Map<string, CalDay>()
  for (const it of items.filter(x => !x.late)) {
    const d = new Date(it.at)
    const key = romeDayKey(d)
    if (!byDay.has(key)) byDay.set(key, { key, label: relativeDay(d, i.now, lang), items: [] })
    byDay.get(key)!.items.push(it)
  }
  return { late, lateMore: lateAll.length - late.length, days: Array.from(byDay.values()), beyond }
}

/** "Today · Thu 22 Oct", "Tomorrow · Fri 23 Oct", "Mon 26 Oct". */
export function relativeDay(d: Date, now: Date, lang: Lang = "en"): string {
  const t: TFn = makeT(lang)
  const k = romeDayKey(d)
  const today = romeDayKey(now)
  const tomorrow = romeDayKey(romeStartOfNextDay(now))
  const base = romeDayLabel(d, lang)
  return k === today ? `${t("Today")} · ${base}` : k === tomorrow ? `${t("Tomorrow")} · ${base}` : base
}

/** The stage a calendar item sits in for the pipeline "by stage" view. */
export type CalStage = "back" | "booked" | "done" | "paid"
/** The lead stages that mean the sale was paid (the seller's board uses the same two). */
const PAID_STAGES = ["paid_call", "upsell_won"]

/** One call on the calendar views (serializable: times are ISO strings). */
export interface CalendarItem {
  kind: "callback" | "appointment"
  leadId: string
  name: string
  at: string
  ad: string | null
  ownerId: string | null
  setBy: string | null
  setByMember: boolean
  /** a call back whose time has passed and nobody has called back */
  late: boolean
  /** a booked call whose time has passed */
  done: boolean
  stage: CalStage
}
export const CALENDAR_LATE_CAP = 300

/**
 * Everything the day, week, month and pipeline views draw, for one person (`ownerId`) or everyone ("all"): the call backs (past ones are "late"), the booked calls (past ones are "done"
 * or "paid"). The late ones are capped (the most recent first) so a long-forgotten backlog cannot make the page heavy; the rest are counted.
 */
export function calendarItems(i: { leads: readonly CalLead[]; events: readonly CalEvent[]; members: readonly CalMember[]; ownerId: string; now: Date; appointments?: readonly CalAppointment[]; lang?: Lang }): { items: CalendarItem[]; lateMore: number } {
  const t = makeT(i.lang ?? "en")
  const nowMs = i.now.getTime()
  const setters = latestSetters(i.events)
  const isMember = (email: string | null) => email !== null && i.members.some(m => m.email !== null && m.email.toLowerCase() === email.toLowerCase() && m.status !== "removed")
  const items: CalendarItem[] = []
  // a call back is superseded by a booked call at or after its time (the setter booked the call the lead was waiting for): it is not shown, so it cannot be moved by mistake
  const bookedAt = new Map<string, number>()
  for (const a of i.appointments ?? []) { const at = Date.parse(a.at); if (!Number.isNaN(at)) bookedAt.set(a.lead.id, Math.max(bookedAt.get(a.lead.id) ?? 0, at)) }
  for (const l of i.leads) {
    if (!l.callback_at || Number.isNaN(Date.parse(l.callback_at))) continue
    if ((bookedAt.get(l.id) ?? -1) >= Date.parse(l.callback_at)) continue
    const setter = setters.get(l.id)?.actor ?? null
    const ownerId = callBackOwner(l, setter, i.members)
    if (i.ownerId !== "all" && ownerId !== i.ownerId) continue
    items.push({ kind: "callback", leadId: l.id, name: l.full_name || l.email || t("Unnamed lead"), at: l.callback_at, ad: l.ad_name, ownerId, setBy: setter ? personName(setter) : null, setByMember: isMember(setter), late: new Date(l.callback_at).getTime() < nowMs, done: false, stage: "back" })
  }
  for (const a of i.appointments ?? []) {
    const at = new Date(a.at).getTime()
    if (Number.isNaN(at)) continue
    const ownerId = callBackOwner(a.lead, a.actor, i.members)
    if (i.ownerId !== "all" && ownerId !== i.ownerId) continue
    const past = at < nowMs
    const paid = past && PAID_STAGES.includes(a.lead.status ?? "")
    items.push({ kind: "appointment", leadId: a.lead.id, name: a.lead.full_name || a.lead.email || t("Unnamed lead"), at: a.at, ad: a.lead.ad_name, ownerId, setBy: personName(a.actor), setByMember: isMember(a.actor), late: false, done: past, stage: paid ? "paid" : past ? "done" : "booked" })
  }
  items.sort((a, b) => a.at.localeCompare(b.at))
  const lateAll = items.filter(x => x.late)
  const keep = new Set(lateAll.slice(-CALENDAR_LATE_CAP))
  return { items: items.filter(x => !x.late || keep.has(x)), lateMore: lateAll.length - keep.size }
}
