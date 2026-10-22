/**
 * The marketing workspace for the team (pure; TD Marketing, dev job 9aec66fa): which screens each person gets, where /marketing sends them, and what the
 * "Today" and "Call list" screens contain. Everything is worked out from the person's permissions and the team's leads, so a new role is a settings change,
 * never a code change. No database here.
 */
import { buildMasterView, romeStartOfDay, romeStartOfNextDay, type MasterEvent, type MasterLead, type MasterMember, type PersonRow, type StageOpt } from "@/lib/marketing/master-view"

export interface Module { key: string; label: string; href: string; built: boolean }

/** Every screen of the approved mockup, in its order, with the permission that opens it. Not-yet-built screens stay on the list, greyed "soon". */
const CATALOG: Array<{ key: string; label: string; href: string; built: boolean; when: (p: readonly string[]) => boolean }> = [
  { key: "today", label: "Today", href: "/marketing/today", built: true, when: p => p.includes("leads.pick") },
  { key: "call-list", label: "Call list", href: "/marketing/call-list", built: true, when: p => p.includes("leads.worklist") },
  { key: "leads", label: "Leads", href: "/marketing/leads", built: true, when: p => p.includes("leads.read") },
  { key: "inbox", label: "Inbox", href: "/marketing/inbox", built: false, when: p => p.includes("inbox") },
  { key: "whatsapp", label: "WhatsApp", href: "/marketing/whatsapp", built: false, when: p => p.includes("whatsapp") },
  { key: "chat", label: "Chat", href: "/marketing/chat", built: false, when: p => p.includes("chat") },
  { key: "calls", label: "Calls", href: "/marketing/calls", built: false, when: p => p.includes("calls.host") },
  { key: "money", label: "Money", href: "/marketing/money", built: true, when: p => p.includes("money.read") },
  { key: "offers", label: "Offers", href: "/marketing/offers", built: false, when: p => p.includes("offers.create") },
  { key: "content", label: "Content", href: "/marketing/content", built: false, when: p => p.includes("content.manage") },
  { key: "my-numbers", label: "My numbers", href: "/marketing/my-numbers", built: true, when: p => p.includes("leads.worklist") },
  { key: "activity", label: "Team activity", href: "/marketing/activity", built: true, when: p => p.includes("team.activity") },
  { key: "reports", label: "Reports", href: "/marketing/reports", built: true, when: p => p.includes("reports.read") || p.includes("leads.pick") },
  { key: "team", label: "Team", href: "/marketing/team", built: true, when: p => p.includes("team.manage") },
]

export function modulesFor(perms: readonly string[]): Module[] {
  return CATALOG.filter(m => m.when(perms)).map(({ key, label, href, built }) => ({ key, label, href, built }))
}

/** Where /marketing sends a person: the first screen that exists for him. null = nothing to open (no permissions at all). */
export function homeFor(perms: readonly string[]): string | null {
  return modulesFor(perms).find(m => m.built)?.href ?? null
}

export interface OutcomeStages { good: string; not_in_target: string; call_back: string }

/** The stages a paid sale moves a lead to: the values of the sale_kind_stages setting, without repeats. */
export function paidStagesFrom(map: Record<string, string> | null | undefined): string[] {
  return Array.from(new Set(Object.values(map ?? {}).filter((v): v is string => typeof v === "string" && v !== "")))
}
const dueBy = (l: { callback_at: string | null }, limit: number) => l.callback_at !== null && new Date(l.callback_at).getTime() < limit
const arrival = (l: { meta_created_time: string | null; received_at: string }) => new Date(l.meta_created_time ?? l.received_at).getTime()

export interface QueueLead extends MasterLead { meta_created_time: string | null; phone: string | null }

/**
 * The setter's call list: first the call backs due today (earliest first; the late ones are the top of the list), then the new leads nobody has worked,
 * oldest first (the one waiting longest is called first). A lead someone else picked is not on the list.
 */
export function callQueue<T extends QueueLead>(leads: readonly T[], firstStage: string, me: string, now: Date): T[] {
  const dayEnd = romeStartOfNextDay(now).getTime()
  const mineOrFree = (l: T) => l.claimed_by === null || l.claimed_by === me
  const callbacks = leads.filter(l => mineOrFree(l) && dueBy(l, dayEnd)).sort((a, b) => String(a.callback_at).localeCompare(String(b.callback_at)))
  const ids = new Set(callbacks.map(l => l.id))
  const fresh = leads.filter(l => mineOrFree(l) && !ids.has(l.id) && l.status === firstStage && l.callback_at === null).sort((a, b) => arrival(a) - arrival(b))
  return [...callbacks, ...fresh]
}

/** The lead after `currentId` in the queue; the previous one when it was the last; null when the queue is empty. */
export function nextInQueue<T extends { id: string }>(queue: readonly T[], currentId: string): T | null {
  const i = queue.findIndex(l => l.id === currentId)
  if (i === -1) return queue[0] ?? null
  return queue[i + 1] ?? queue[i - 1] ?? null
}

export interface TodayLead extends QueueLead { claimed_at?: string | null }
/** A lead a setter marked "Not in target" today, for the owner to look over (and, later, to overturn). */
export interface RejectedToday { lead: TodayLead; by: string; at: string; reason: string | null; note: string }
export interface TodayModel {
  callBacks: Array<{ lead: TodayLead; late: boolean }>
  goodWaiting: TodayLead[]
  /** new leads nobody has touched for more than a day, the one waiting longest first */
  waitingOver24h: TodayLead[]
  rejectedToday: RejectedToday[]
  mine: TodayLead[]
  people: PersonRow[]
}

const HOUR_MS = 3600_000

/** The owner's "Today": call backs due (late ones flagged), the Good leads waiting for a pick (longest waiting first), his own open leads, what each person did today. */
export function todayModel(i: {
  leads: readonly TodayLead[]; events: readonly MasterEvent[]; members: readonly MasterMember[]; stages: readonly StageOpt[]
  outcomeStages: OutcomeStages; me: string; now: Date
  /** stages that mean "a sale was paid" (from the settings); default: the built-in two */
  paidStages?: readonly string[]
}): TodayModel {
  const nowMs = i.now.getTime()
  const dayEnd = romeStartOfNextDay(i.now).getTime()
  const callBacks = i.leads.filter(l => dueBy(l, dayEnd) && (l.claimed_by === null || l.claimed_by === i.me))
    .sort((a, b) => String(a.callback_at).localeCompare(String(b.callback_at)))
    .map(lead => ({ lead, late: new Date(lead.callback_at as string).getTime() < nowMs }))
  const goodWaiting = i.leads.filter(l => l.status === i.outcomeStages.good && l.claimed_by === null).sort((a, b) => arrival(a) - arrival(b))
  const done = new Set([i.outcomeStages.not_in_target, ...(i.paidStages?.length ? i.paidStages : ["paid_call", "upsell_won"])])
  const mine = i.leads.filter(l => l.claimed_by === i.me && !done.has(l.status)).sort((a, b) => String(b.claimed_at ?? "").localeCompare(String(a.claimed_at ?? "")))
  const people = buildMasterView({ leads: i.leads, events: i.events, members: i.members, stages: i.stages, now: i.now, paidStages: i.paidStages }).people
  const firstStage = i.stages[0]?.key
  const waitingOver24h = firstStage === undefined ? [] : i.leads.filter(l => l.status === firstStage && l.claimed_by === null && l.callback_at === null && nowMs - arrival(l) > 24 * HOUR_MS).sort((a, b) => arrival(a) - arrival(b))
  // rejected today: the newest "Not in target" decision of each lead made since midnight (Rome), by a real person, for a lead that is still rejected
  const dayStart = romeStartOfDay(i.now).getTime()
  const byLead = new Map(i.leads.map(l => [l.id, l]))
  const seen = new Set<string>()
  const rejectedToday: RejectedToday[] = []
  for (const e of [...i.events].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (e.kind !== "status_changed" || e.data?.outcome !== "not_in_target" || e.data?.via_view_as === true) continue
    if (new Date(e.created_at).getTime() < dayStart || seen.has(e.lead_id)) continue
    seen.add(e.lead_id)
    const lead = byLead.get(e.lead_id)
    if (!lead || lead.status !== i.outcomeStages.not_in_target) continue
    rejectedToday.push({ lead, by: e.actor, at: e.created_at, reason: typeof e.data?.reason === "string" ? e.data.reason : null, note: typeof e.data?.note === "string" ? e.data.note.trim() : "" })
  }
  return { callBacks, goodWaiting, waitingOver24h, rejectedToday, mine, people }
}
