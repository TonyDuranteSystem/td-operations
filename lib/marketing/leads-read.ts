/**
 * Reading leads for the screens (server; TD Marketing, dev job 9aec66fa). Every team-facing read takes the team id from the
 * GUARD's context and puts it in the query itself, so guessing another team's lead id returns nothing, not someone else's lead.
 * Only Antonio's admin page reads across teams (`listAllLeads`).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"

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

export async function listTeamLeads(db: Db, teamId: string, limit = 200): Promise<LeadRow[]> {
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).order("received_at", { ascending: false }).limit(limit)
  return (data ?? []) as LeadRow[]
}

export async function getTeamLead(db: Db, teamId: string, id: string): Promise<LeadRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).eq("id", id).maybeSingle()
  return (data ?? null) as LeadRow | null
}

export async function leadTimeline(db: Db, leadId: string): Promise<LeadEventRow[]> {
  const { data } = await db.from("marketing_lead_events").select("id, kind, actor, data, created_at").eq("lead_id", leadId).order("created_at", { ascending: true }).limit(200)
  return (data ?? []) as LeadEventRow[]
}

/** Antonio's master list: every team's leads, plus those not assigned to a team yet. Admin pages only. */
export async function listAllLeads(db: Db, limit = 300): Promise<LeadRow[]> {
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).order("received_at", { ascending: false }).limit(limit)
  return (data ?? []) as LeadRow[]
}
