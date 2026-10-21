/**
 * TD Marketing — "My numbers" and "Reports" (pure; dev job 9aec66fa). Counting only: `numbers-read.ts` loads the rows. Every number has its definition here.
 * Periods are Rome days / weeks (Monday start) / months, the team's own clock. A setter's outcome is the history row he wrote when he pressed Good,
 * Not in target or Call back later (the history keeps WHO did it), so a number never depends on a lead's current stage.
 * Calls themselves are not recorded yet, so there is no "called" number: "worked" means the leads he gave an outcome.
 */
import { romeStartOfDay, romeStartOfMonth, MASTER_TZ, type MasterEvent } from "@/lib/marketing/master-view"
import { isReceived, type SaleRow } from "@/lib/marketing/sales"

export type Period = "today" | "week" | "month" | "all"
export const PERIODS: ReadonlyArray<{ key: Period; label: string }> = [
  { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "all", label: "All time" },
]
export function parsePeriod(v: string | string[] | undefined): Period {
  const s = Array.isArray(v) ? v[0] : v
  return PERIODS.some(p => p.key === s) ? (s as Period) : "week"
}

/** Start of the Monday of the Rome week that contains `at`. */
export function romeStartOfWeek(at: Date): Date {
  const day = romeStartOfDay(at)
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: MASTER_TZ, weekday: "short" }).format(at) // Mon..Sun
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd)
  return romeStartOfDay(new Date(day.getTime() - Math.max(0, back) * 86_400_000 + 12 * 3600_000))
}

/** The instant a period starts; null = no lower limit (all time). */
export function periodStart(p: Period, now: Date): Date | null {
  if (p === "today") return romeStartOfDay(now)
  if (p === "week") return romeStartOfWeek(now)
  if (p === "month") return romeStartOfMonth(now)
  return null
}

export type Outcome = "good" | "not_in_target" | "call_back"
export interface OutcomeRow { leadId: string; actor: string; outcome: Outcome; reason: string | null; at: string }

/** The outcome history rows (Good / Not in target / Call back later) in the period, oldest first. */
export function outcomesIn(events: readonly MasterEvent[], from: Date | null): OutcomeRow[] {
  const out: OutcomeRow[] = []
  for (const e of events) {
    if (e.kind !== "status_changed") continue
    const o = e.data?.outcome
    if (o !== "good" && o !== "not_in_target" && o !== "call_back") continue
    if (from && new Date(e.created_at).getTime() < from.getTime()) continue
    out.push({ leadId: e.lead_id, actor: e.actor, outcome: o, reason: typeof e.data?.reason === "string" ? e.data.reason : null, at: e.created_at })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

export interface PersonNumbers { worked: number; good: number; notInTarget: number; callBacks: number; goodRatePct: number | null; paidLeads: number }

/** A leads is "paid" for a person when he marked it Good in the period and it now has a paid sale (money received, not a link or a refund). */
export function personNumbers(rows: readonly OutcomeRow[], sales: readonly Pick<SaleRow, "lead_id" | "status">[], actor: string): PersonNumbers {
  const mine = rows.filter(r => r.actor === actor)
  const count = (o: Outcome) => mine.filter(r => r.outcome === o).length
  const good = count("good"), notInTarget = count("not_in_target"), callBacks = count("call_back")
  const paidLead = new Set(sales.filter(isReceived).map(s => s.lead_id))
  const goodLeads = new Set(mine.filter(r => r.outcome === "good").map(r => r.leadId))
  return {
    worked: good + notInTarget + callBacks, good, notInTarget, callBacks,
    goodRatePct: good + notInTarget > 0 ? Math.round((good / (good + notInTarget)) * 100) : null,
    paidLeads: Array.from(goodLeads).filter(id => paidLead.has(id)).length,
  }
}

/** Why leads were not in target: the reason chosen, counted, biggest first. An unknown key is shown as itself. */
export function reasonCounts(rows: readonly OutcomeRow[], reasons: readonly { key: string; label: string }[]): Array<{ label: string; n: number }> {
  const m = new Map<string, number>()
  for (const r of rows) if (r.outcome === "not_in_target") m.set(r.reason ?? "unknown", (m.get(r.reason ?? "unknown") ?? 0) + 1)
  return Array.from(m.entries()).map(([k, n]) => ({ label: reasons.find(x => x.key === k)?.label ?? (k === "unknown" ? "No reason given" : k), n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
}

export interface AdLead { id: string; ad_name: string | null; campaign_name: string | null; received_at: string; meta_created_time: string | null }
export interface AdRow { ad: string; leads: number; good: number; notInTarget: number; paid: number }

const arrived = (l: AdLead) => new Date(l.meta_created_time ?? l.received_at).getTime()

/**
 * Leads per ad that ARRIVED in the period, with what became of them (all outcomes ever, not only this period's) and how many paid. A lead with no ad name is
 * counted under "No ad name". No cost here: ad spend is not connected to this system yet.
 */
export function adTable(leads: readonly AdLead[], allOutcomes: readonly OutcomeRow[], sales: readonly Pick<SaleRow, "lead_id" | "status">[], from: Date | null): AdRow[] {
  const goodLeads = new Set(allOutcomes.filter(o => o.outcome === "good").map(o => o.leadId))
  const nitLeads = new Set(allOutcomes.filter(o => o.outcome === "not_in_target").map(o => o.leadId))
  const paidLeads = new Set(sales.filter(isReceived).map(s => s.lead_id))
  const m = new Map<string, AdRow>()
  for (const l of leads) {
    if (from && arrived(l) < from.getTime()) continue
    const key = l.ad_name?.trim() || "No ad name"
    const r = m.get(key) ?? { ad: key, leads: 0, good: 0, notInTarget: 0, paid: 0 }
    r.leads += 1
    if (goodLeads.has(l.id)) r.good += 1
    if (nitLeads.has(l.id)) r.notInTarget += 1
    if (paidLeads.has(l.id)) r.paid += 1
    m.set(key, r)
  }
  return Array.from(m.values()).sort((a, b) => b.leads - a.leads || a.ad.localeCompare(b.ad))
}

export interface SetterRow extends PersonNumbers { actor: string }

/** One row per person who gave an outcome in the period, most worked first. */
export function setterTable(rows: readonly OutcomeRow[], sales: readonly Pick<SaleRow, "lead_id" | "status">[]): SetterRow[] {
  return Array.from(new Set(rows.map(r => r.actor))).map(actor => ({ actor, ...personNumbers(rows, sales, actor) })).sort((a, b) => b.worked - a.worked || a.actor.localeCompare(b.actor))
}
