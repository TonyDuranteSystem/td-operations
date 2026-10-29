/**
 * The owner's Home (pure; TD Marketing, dev job 9aec66fa; Antonio, 27 Oct 2026: "where should I see my dashboard, to see, check, answer messages"): one screen with what needs him.
 * Four numbers, the messages waiting for him (the chats about leads and his direct messages and groups), what is waiting on Rocco, and today's booked calls.
 * Everything comes from rows the other screens already read; no database here.
 */
import { columnOf } from "@/lib/marketing/board"
import { countsAsWork, romeStartOfDay, romeStartOfNextDay, type MasterEvent } from "@/lib/marketing/master-view"
import { romeDayKey } from "@/lib/marketing/calendar"
import type { Conversation } from "@/lib/marketing/lead-chat-server"
import type { ThreadRow } from "@/lib/marketing/team-chat"

export interface HomeLead { id: string; status: string; full_name: string | null; email: string | null; received_at: string; meta_created_time: string | null; claimed_by: string | null; callback_at: string | null }
export interface HomeCall { lead: { id: string; full_name: string | null; email: string | null }; at: string; actor: string }

export interface HomeMessage { key: string; kind: "lead" | "thread"; id: string; title: string; by: string; text: string; at: string | null; mentioned: boolean }
export interface WaitingGroup { key: "link_unpaid" | "paid_no_booking" | "untouched"; count: number; leads: Array<{ id: string; name: string }> }
export interface HomeModel {
  numbers: { newToday: number; withSeller: number; linksToday: number; paidToday: number }
  messages: HomeMessage[]
  messagesTotal: number
  waiting: WaitingGroup[]
  waitingTotal: number
  callsToday: Array<{ leadId: string; name: string; at: string; actor: string }>
}

/** how long a payment link may sit unpaid before it shows under "waiting on Rocco" */
export const LINK_UNPAID_HOURS = 48
export const MESSAGES_SHOWN = 8
export const NAMES_SHOWN = 5
const HOUR_MS = 3600_000
const arrival = (l: Pick<HomeLead, "meta_created_time" | "received_at">) => new Date(l.meta_created_time ?? l.received_at).getTime()
const nameOf = (l: { full_name: string | null; email: string | null }, fallback: string) => l.full_name || l.email || fallback

/** The seller board's columns that count as "with Rocco": Interested lead, Contacted, Link sent (a lead the setter has not passed on is still the setter's). */
const WITH_SELLER = ["booked", "contacted", "closed"]

export function homeModel(i: {
  leads: readonly HomeLead[]
  /** history rows since the start of the month (the newest payment link of a lead is needed, not only today's) */
  events: readonly MasterEvent[]
  conversations: readonly Conversation[]
  threads: readonly ThreadRow[]
  calls: readonly HomeCall[]
  now: Date
  /** the stage a brand-new lead starts at (the setter's first stage) */
  firstStage: string | undefined
  unnamed: string
}): HomeModel {
  const nowMs = i.now.getTime()
  const dayStart = romeStartOfDay(i.now).getTime()
  const dayEnd = romeStartOfNextDay(i.now).getTime()
  const real = i.events.filter(countsAsWork)

  const todays = (kind: string) => real.filter(e => e.kind === kind && new Date(e.created_at).getTime() >= dayStart)
  const numbers = {
    newToday: i.leads.filter(l => arrival(l) >= dayStart && arrival(l) < dayEnd).length,
    withSeller: i.leads.filter(l => l.status !== "qualified" && WITH_SELLER.includes(columnOf("seller", l.status) ?? "")).length,
    linksToday: new Set(todays("payment_link_created").map(e => (typeof e.data?.sale_id === "string" ? e.data.sale_id : `${e.lead_id}:${e.created_at}`))).size,
    paidToday: new Set(todays("payment_received").map(e => (typeof e.data?.sale_id === "string" ? e.data.sale_id : `${e.lead_id}:${e.created_at}`))).size,
  }

  // a chat about a lead is his only when somebody NAMED him in it (Antonio, 29 Oct 2026); the others stay in Messages
  const fromLeads: HomeMessage[] = i.conversations.filter(c => c.unread > 0 && c.mentioned === true).map(c => ({ key: `lead:${c.leadId}`, kind: "lead", id: c.leadId, title: c.name, by: c.lastBy, text: c.last, at: c.lastAt, mentioned: true }))
  const fromThreads: HomeMessage[] = i.threads.filter(t => t.unread > 0).map(t => ({ key: `thread:${t.id}`, kind: "thread", id: t.id, title: t.title, by: t.lastBy, text: t.last, at: t.lastAt, mentioned: t.mentioned }))
  const all = [...fromLeads, ...fromThreads].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))

  // the newest payment link of each lead: a lead at "Link sent" whose newest link is older than the limit has not paid and has not answered
  const newestLink = new Map<string, number>()
  for (const e of real) {
    if (e.kind !== "payment_link_created") continue
    const at = new Date(e.created_at).getTime()
    if (at > (newestLink.get(e.lead_id) ?? 0)) newestLink.set(e.lead_id, at)
  }
  const linkUnpaid = i.leads.filter(l => columnOf("seller", l.status) === "closed" && nowMs - (newestLink.get(l.id) ?? nowMs) > LINK_UNPAID_HOURS * HOUR_MS)
    .sort((a, b) => (newestLink.get(a.id) ?? 0) - (newestLink.get(b.id) ?? 0))
  const paidNoBooking = i.leads.filter(l => columnOf("seller", l.status) === "paid")
  const untouched = i.firstStage === undefined ? [] : i.leads.filter(l => l.status === i.firstStage && l.claimed_by === null && l.callback_at === null && nowMs - arrival(l) > 24 * HOUR_MS).sort((a, b) => arrival(a) - arrival(b))
  const group = (key: WaitingGroup["key"], list: readonly HomeLead[]): WaitingGroup => ({ key, count: list.length, leads: list.slice(0, NAMES_SHOWN).map(l => ({ id: l.id, name: nameOf(l, i.unnamed) })) })
  const waiting = [group("link_unpaid", linkUnpaid), group("paid_no_booking", paidNoBooking), group("untouched", untouched)]

  const callsToday = i.calls.filter(c => { const at = Date.parse(c.at); return !Number.isNaN(at) && at >= dayStart && at < dayEnd && romeDayKey(new Date(at)) === romeDayKey(i.now) })
    .sort((a, b) => a.at.localeCompare(b.at)).map(c => ({ leadId: c.lead.id, name: nameOf(c.lead, i.unnamed), at: c.at, actor: c.actor }))

  return { numbers, messages: all.slice(0, MESSAGES_SHOWN), messagesTotal: all.length, waiting, waitingTotal: waiting.reduce((n, g) => n + g.count, 0), callsToday }
}
