/**
 * Loading what Antonio's master view counts (server; TD Marketing, dev job 9aec66fa). Admin pages only: the caller has already checked who is asking.
 * The numbers themselves are made in `master-view.ts` (pure).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { buildMasterView, romeStartOfMonth, type MasterEvent, type MasterLead, type MasterMember, type MasterView, type StageOpt } from "@/lib/marketing/master-view"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { listMembers } from "@/lib/marketing/members"

const LEAD_COLS = "id, status, team_id, full_name, email, claimed_by, callback_at, received_at, meta_created_time, existing_client"

export interface MasterData {
  view: MasterView
  stages: StageOpt[]
  leadCount: number
  memberCount: number
  /** when the safety re-read of Meta last ran (ISO) and what is stuck */
  lastCheckAt: string | null
  failedCount: number
}

export async function loadMasterData(db: Db, teamId: string, now = new Date()): Promise<MasterData> {
  const [leadsRes, noTeamRes, evRes, stages, members, cron, stuck] = await Promise.all([
    db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).order("received_at", { ascending: false }).limit(5000),
    db.from("marketing_leads").select("id", { count: "exact", head: true }).is("team_id", null),
    db.from("marketing_lead_events").select("lead_id, kind, actor, data, created_at").gte("created_at", romeStartOfMonth(now).toISOString()).order("created_at", { ascending: true }).limit(20000),
    getMarketingSetting("pipeline_stages", teamId) as Promise<StageOpt[]>,
    listMembers(teamId),
    db.from("cron_log").select("executed_at").eq("endpoint", "/api/cron/marketing-lead-retry").order("executed_at", { ascending: false }).limit(1),
    db.from("marketing_leadgen_events").select("id", { count: "exact", head: true }).in("status", ["failed", "gave_up"]),
  ])
  const leads = (leadsRes.data ?? []) as MasterLead[]
  const leadIds = new Set(leads.map(l => l.id))
  // history rows belong to leads of THIS team only
  const events = ((evRes.data ?? []) as MasterEvent[]).filter(e => leadIds.has(e.lead_id))
  const people: MasterMember[] = members.map(m => ({ email: m.email, role: m.member_role as "owner" | "member", bundle: m.bundle, status: m.status, lastSignInAt: m.last_sign_in_at }))
  return {
    view: buildMasterView({ leads, events, members: people, stages, now, unassignedCount: noTeamRes.count ?? 0 }),
    stages, leadCount: leads.length, memberCount: people.filter(p => p.status !== "removed").length,
    lastCheckAt: (cron.data?.[0] as { executed_at?: string } | undefined)?.executed_at ?? null,
    failedCount: stuck.count ?? 0,
  }
}
