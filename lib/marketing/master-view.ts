/**
 * Antonio's master view of a marketing team (pure; TD Marketing, dev job 9aec66fa). Turns the team's leads and the history rows into the numbers
 * on the page. No database here: `master-read.ts` loads the rows, this file only counts, so every number has a definition in one place and a test.
 * "Today" and "this month" are in Rome time, the team's own clock, so the page says the same thing to everyone.
 */
export const MASTER_TZ = "Europe/Rome"
const HOUR = 3600_000

export interface MasterLead {
  id: string
  status: string
  team_id: string | null
  full_name: string | null
  email: string | null
  claimed_by: string | null
  callback_at: string | null
  received_at: string
  meta_created_time: string | null
  existing_client: { contact_ids?: string[]; check_failed?: boolean } | null
}
export interface MasterEvent { lead_id: string; kind: string; actor: string; data: Record<string, unknown>; created_at: string }
export interface MasterMember { email: string | null; role: "owner" | "member"; bundle: string | null; status: string; lastSignInAt: string | null }
export interface StageOpt { key: string; label: string }

/** A history row that counts as a person's real work: Antonio looking in with "View as" is tagged and never counted. */
export const countsAsWork = (e: Pick<MasterEvent, "data">): boolean => e.data?.via_view_as !== true

export interface MasterInput {
  /** the stages a paid sale moves a lead to (the values of the sale_kind_stages setting); default: the built-in one */
  paidStages?: readonly string[]
  leads: readonly MasterLead[]
  /** history rows since the start of the month (earlier ones are not needed) */
  events: readonly MasterEvent[]
  members: readonly MasterMember[]
  stages: readonly StageOpt[]
  now: Date
  /** leads with no team at all (they belong to nobody's list, so they are counted apart); default: counted from `leads` */
  unassignedCount?: number
}

const arrivedAt = (l: MasterLead) => new Date(l.meta_created_time ?? l.received_at).getTime()
const nameOf = (l: MasterLead) => l.full_name || l.email || "Unnamed lead"

/** Offset of Rome from UTC at an instant, in ms. */
function offsetMs(at: Date): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: MASTER_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at)
  const g = (t: string) => Number(p.find(x => x.type === t)?.value)
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(at.getTime() / 1000) * 1000
}
/** Start of the Rome day (and of the Rome month) that contains `at`, as UTC instants. */
export function romeStartOfDay(at: Date): Date {
  const local = new Date(at.getTime() + offsetMs(at))
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return new Date(startLocal - offsetMs(new Date(startLocal - offsetMs(at))))
}
/** Start of the NEXT Rome day: a Rome day is 23, 24 or 25 hours long on the two clock-change days, so "+ 24 h" is wrong then. */
export function romeStartOfNextDay(at: Date): Date {
  return romeStartOfDay(new Date(romeStartOfDay(at).getTime() + 30 * 3600_000))
}
export function romeStartOfMonth(at: Date): Date {
  const local = new Date(at.getTime() + offsetMs(at))
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)
  return new Date(startLocal - offsetMs(new Date(startLocal - offsetMs(at))))
}

export function ageText(ms: number): string {
  const h = Math.floor(ms / HOUR)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

export interface NeedsItem { key: "untouched" | "unassigned" | "late_callbacks" | "existing_client"; text: string; tone: "bad" | "warn" }
export interface PersonRow { email: string; role: string; good: number; notInTarget: number; callBacks: number; picked: number; lastActive: string | null }
export interface MasterView {
  newLast24h: number
  untouchedOver24h: number
  oldestUntouchedMs: number | null
  callBacksDueToday: number
  paidCallsThisMonth: number
  funnel: Array<{ key: string; label: string; count: number }>
  needs: NeedsItem[]
  people: PersonRow[]
}

export function buildMasterView(i: MasterInput): MasterView {
  const nowMs = i.now.getTime()
  const firstStage = i.stages[0]?.key ?? "new"
  const dayStart = romeStartOfDay(i.now).getTime()
  const dayEnd = romeStartOfNextDay(i.now).getTime()
  const monthStart = romeStartOfMonth(i.now).getTime()

  const newLast24h = i.leads.filter(l => nowMs - arrivedAt(l) <= 24 * HOUR).length

  // "Untouched": still in the first stage, nobody picked it, and it arrived more than a day ago.
  const untouched = i.leads.filter(l => l.status === firstStage && l.claimed_by === null && nowMs - arrivedAt(l) > 24 * HOUR)
  const oldest = untouched.length ? Math.max(...untouched.map(l => nowMs - arrivedAt(l))) : null

  const withCallback = i.leads.filter(l => l.callback_at !== null && !Number.isNaN(new Date(l.callback_at).getTime()))
  const dueToday = withCallback.filter(l => new Date(l.callback_at as string).getTime() < dayEnd)
  const late = dueToday.filter(l => new Date(l.callback_at as string).getTime() < nowMs).sort((a, b) => String(a.callback_at).localeCompare(String(b.callback_at)))

  const paidStages = new Set(i.paidStages?.length ? i.paidStages : ["paid_call"])
  const paidThisMonth = new Set(i.events.filter(e => e.kind === "status_changed" && typeof e.data?.to === "string" && paidStages.has(e.data.to) && new Date(e.created_at).getTime() >= monthStart).map(e => e.lead_id)).size

  const known = new Set(i.stages.map(s => s.key))
  const funnel = i.stages.map(s => ({ key: s.key, label: s.label, count: i.leads.filter(l => l.status === s.key).length }))
  const stray = i.leads.filter(l => !known.has(l.status)).length
  if (stray) funnel.push({ key: "_other", label: "Other", count: stray })

  const needs: NeedsItem[] = []
  if (untouched.length) needs.push({ key: "untouched", tone: "bad", text: `${untouched.length} lead${untouched.length === 1 ? "" : "s"} untouched for over a day (oldest: ${ageText(oldest as number)})` })
  const unassigned = i.unassignedCount ?? i.leads.filter(l => !l.team_id).length
  if (unassigned) needs.push({ key: "unassigned", tone: "warn", text: `${unassigned} lead${unassigned === 1 ? "" : "s"} that arrived with no team` })
  for (const l of late.slice(0, 3)) needs.push({ key: "late_callbacks", tone: "bad", text: `Call back with ${nameOf(l)} is ${ageText(nowMs - new Date(l.callback_at as string).getTime())} late` })
  if (late.length > 3) needs.push({ key: "late_callbacks", tone: "bad", text: `${late.length - 3} more call backs are late` })
  const flagged = i.leads.filter(l => l.existing_client && (l.existing_client.contact_ids?.length || l.existing_client.check_failed) && l.status === firstStage)
  for (const l of flagged.slice(0, 3)) needs.push({ key: "existing_client", tone: "warn", text: `${nameOf(l)} ${l.existing_client?.check_failed ? "could not be checked against TD clients" : "looks like an existing client"}` })

  // What each person did today. Events are matched to people by the email stored as the actor.
  const work = i.events.filter(countsAsWork)
  const today = work.filter(e => new Date(e.created_at).getTime() >= dayStart)
  const people: PersonRow[] = i.members.filter(m => m.status !== "removed" && m.email).map(m => {
    const mine = today.filter(e => e.actor === m.email)
    const outcome = (o: string) => mine.filter(e => e.kind === "status_changed" && e.data?.outcome === o).length
    const lastEvent = work.filter(e => e.actor === m.email).map(e => e.created_at).sort().pop() ?? null
    const lastActive = [lastEvent, m.lastSignInAt].filter((x): x is string => !!x).sort().pop() ?? null
    return {
      email: m.email as string, role: m.role === "owner" ? "Owner" : (m.bundle ?? "Member"),
      good: outcome("good"), notInTarget: outcome("not_in_target"), callBacks: outcome("call_back"), picked: mine.filter(e => e.kind === "claimed").length, lastActive,
    }
  })

  return { newLast24h, untouchedOver24h: untouched.length, oldestUntouchedMs: oldest, callBacksDueToday: dueToday.length, paidCallsThisMonth: paidThisMonth, funnel, needs, people }
}
