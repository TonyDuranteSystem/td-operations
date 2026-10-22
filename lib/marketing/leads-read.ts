/**
 * Reading leads for the screens (server; TD Marketing, dev job 9aec66fa). Every team-facing read takes the team id from the
 * GUARD's context and puts it in the query itself, so guessing another team's lead id returns nothing, not someone else's lead.
 * Only Antonio's admin page reads across teams (`listAllLeads`).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { readPaged } from "@/lib/marketing/paged"

export interface LeadRow {
  id: string
  team_id: string | null
  leadgen_id: string
  full_name: string | null
  email: string | null
  phone: string | null
  country: string | null
  city: string | null
  answers: Array<{ name: string; values: string[] }>
  campaign_name: string | null
  adset_name: string | null
  ad_name: string | null
  form_id: string | null
  platform: string | null
  status: string
  existing_client: { contact_ids?: string[]; matched_on?: string[]; check_failed?: boolean } | null
  meta_created_time: string | null
  received_at: string
  claimed_by: string | null
  claimed_by_label: string | null
  claimed_at: string | null
  callback_at: string | null
  not_in_target_reason: string | null
  qualification: Array<{ item: string; ticked: boolean }> | null
}

export interface LeadEventRow { id: number; kind: string; actor: string; data: Record<string, unknown>; created_at: string }

export const LEAD_COLS = "id, team_id, leadgen_id, full_name, email, phone, country, city, answers, campaign_name, adset_name, ad_name, form_id, platform, status, existing_client, meta_created_time, received_at, claimed_by, claimed_by_label, claimed_at, callback_at, not_in_target_reason, qualification"

/** What narrows the Leads list. All of it is part of the database query, so the newest-500 cap applies to the matching leads, never to leads that were about to be filtered out. */
export interface LeadFilters {
  /** a pipeline stage key */
  stage?: string
  /** an ad name; NO_AD = leads that came with no ad name */
  ad?: string
  /** "free" = nobody picked it; "mine" = picked by this user; "callbacks" = has a call back date */
  show?: "all" | "free" | "mine" | "callbacks"
  userId?: string
  /** "oldest" = the lead waiting longest first (the "Not picked yet" view: the overdue ones must never fall off a 500 cap) */
  order?: "newest" | "oldest" | "callback"
}
export const NO_AD = "__none__"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the query builder's type is not exported
function applyFilters(q: any, f: LeadFilters): any {
  if (f.stage) q = q.eq("status", f.stage)
  if (f.ad === NO_AD) q = q.or("ad_name.is.null,ad_name.eq.")
  else if (f.ad) q = q.eq("ad_name", f.ad)
  if (f.show === "free") q = q.is("claimed_by", null)
  else if (f.show === "mine" && f.userId) q = q.eq("claimed_by", f.userId)
  else if (f.show === "callbacks") q = q.not("callback_at", "is", null)
  return q
}

/** Newest first, read in pages (the database cuts one answer at 1000 rows); `truncated` = there are more leads than `limit`. */
export async function listTeamLeadsCapped(db: Db, teamId: string, limit = 200, filters: LeadFilters = {}): Promise<{ rows: LeadRow[]; truncated: boolean }> {
  return readPaged<LeadRow>((from, to) => applyFilters(db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId), filters).order(filters.order === "callback" ? "callback_at" : "received_at", { ascending: filters.order !== "newest" && filters.order !== undefined }).order("id", { ascending: filters.order === "oldest" }).range(from, to), limit)
}

/** How many leads there are under these filters, whatever their stage (a lead whose stage is no longer in the settings is still counted). */
export async function countLeads(db: Db, teamId: string, filters: LeadFilters = {}): Promise<number> {
  const { count, error } = await applyFilters(db.from("marketing_leads").select("id", { count: "exact", head: true }).eq("team_id", teamId), { ...filters, stage: undefined })
  if (error) throw new Error(`could not count the leads: ${error.message}`)
  return count ?? 0
}

/** How many leads sit in each stage (exact counts from the database, not from a capped list), under the other filters. */
export async function countLeadsByStage(db: Db, teamId: string, stageKeys: readonly string[], filters: LeadFilters = {}): Promise<Map<string, number>> {
  const base = { ...filters, stage: undefined }
  const counts = await Promise.all(stageKeys.map(async k => {
    const { count, error } = await applyFilters(db.from("marketing_leads").select("id", { count: "exact", head: true }).eq("team_id", teamId), { ...base, stage: k })
    if (error) throw new Error(`could not count the leads: ${error.message}`)
    return [k, count ?? 0] as const
  }))
  return new Map(counts)
}

/**
 * Every ad the team's leads came from (leads with no ad name are counted under NO_AD), biggest first. The counts follow the other filters (stage, who picked), like the stage strip does,
 * so an ad can show 0; the ad itself is never filtered here. Read in pages of a few small columns.
 */
export async function listAdNames(db: Db, teamId: string, filters: LeadFilters = {}): Promise<Array<{ name: string; count: number }>> {
  const { rows } = await readPaged<{ ad_name: string | null; status: string; claimed_by: string | null; callback_at: string | null }>((from, to) =>
    db.from("marketing_leads").select("ad_name, status, claimed_by, callback_at").eq("team_id", teamId).order("id", { ascending: true }).range(from, to), 50000)
  const counted = (r: (typeof rows)[number]) =>
    (!filters.stage || r.status === filters.stage)
    && (filters.show !== "free" || r.claimed_by === null)
    && (filters.show !== "mine" || !filters.userId || r.claimed_by === filters.userId)
    && (filters.show !== "callbacks" || r.callback_at !== null)
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.ad_name || NO_AD, (by.get(r.ad_name || NO_AD) ?? 0) + (counted(r) ? 1 : 0))
  return Array.from(by, ([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
}

export async function listTeamLeads(db: Db, teamId: string, limit = 200): Promise<LeadRow[]> {
  return (await listTeamLeadsCapped(db, teamId, limit)).rows
}

/** The team's leads with these ids (chunked, newest first). The team filter stays in the query, so another team's id finds nothing. */
export async function listTeamLeadsByIds(db: Db, teamId: string, ids: readonly string[]): Promise<LeadRow[]> {
  const out: LeadRow[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).in("id", ids.slice(i, i + 100))
    if (error) throw new Error(`could not read the leads: ${error.message}`)
    out.push(...((data ?? []) as LeadRow[]))
  }
  return out.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? "") || b.id.localeCompare(a.id))
}

export async function getTeamLead(db: Db, teamId: string, id: string): Promise<LeadRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).eq("id", id).maybeSingle()
  return (data ?? null) as LeadRow | null
}

export async function leadTimeline(db: Db, leadId: string): Promise<LeadEventRow[]> {
  // The newest 200 (a cap must never drop the latest note), shown oldest to newest.
  const { data } = await db.from("marketing_lead_events").select("id, kind, actor, data, created_at").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(200)
  return ((data ?? []) as LeadEventRow[]).reverse()
}

/** Antonio's master list: every team's leads, plus those not assigned to a team yet. Admin pages only. */
export async function listAllLeads(db: Db, limit = 300): Promise<LeadRow[]> {
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).order("received_at", { ascending: false }).limit(limit)
  return (data ?? []) as LeadRow[]
}
