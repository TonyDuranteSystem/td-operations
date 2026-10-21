/**
 * Loading what Antonio's master view counts (server; TD Marketing, dev job 9aec66fa). Admin pages only: the caller has already checked who is asking.
 * The numbers themselves are made in `master-view.ts` (pure).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { buildMasterView, romeStartOfMonth, type MasterLead, type MasterMember, type MasterView, type StageOpt } from "@/lib/marketing/master-view"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { listMembers } from "@/lib/marketing/members"
import { loadTeamEvents } from "@/lib/marketing/events-read"
import { readPaged } from "@/lib/marketing/paged"
import { paidStagesFrom } from "@/lib/marketing/workspace"

const LEAD_COLS = "id, status, team_id, full_name, email, claimed_by, callback_at, received_at, meta_created_time, existing_client"

export interface MasterData {
  view: MasterView
  stages: StageOpt[]
  leadCount: number
  memberCount: number
  /** when the safety re-read of Meta last ran (ISO) and what is stuck */
  lastCheckAt: string | null
  failedCount: number
  /** some history rows were beyond the read limit and are not counted */
  truncated: boolean
}

export async function loadMasterData(db: Db, teamId: string, now = new Date()): Promise<MasterData> {
  const [leadsRes, noTeamRes, ev, stages, members, cron, stuck, saleStages] = await Promise.all([
    readPaged<MasterLead>((from, to) => db.from("marketing_leads").select(LEAD_COLS).eq("team_id", teamId).order("received_at", { ascending: false }).order("id", { ascending: false }).range(from, to), 5000),
    db.from("marketing_leads").select("id", { count: "exact", head: true }).is("team_id", null),
    loadTeamEvents(db, teamId, { since: romeStartOfMonth(now) }),
    getMarketingSetting("pipeline_stages", teamId) as Promise<StageOpt[]>,
    listMembers(teamId),
    db.from("cron_log").select("executed_at").eq("endpoint", "/api/cron/marketing-lead-retry").order("executed_at", { ascending: false }).limit(1),
    db.from("marketing_leadgen_events").select("id", { count: "exact", head: true }).in("status", ["failed", "gave_up"]),
    getMarketingSetting("sale_kind_stages", teamId) as Promise<Record<string, string>>,
  ])
  const leads = leadsRes.rows
  const events = ev.events
  const people: MasterMember[] = members.map(m => ({ email: m.email, role: m.member_role as "owner" | "member", bundle: m.bundle, status: m.status, lastSignInAt: m.last_sign_in_at }))
  return {
    view: buildMasterView({ leads, events, members: people, stages, now, unassignedCount: noTeamRes.count ?? 0, paidStages: paidStagesFrom(saleStages) }),
    stages, leadCount: leads.length, memberCount: people.filter(p => p.status !== "removed").length,
    lastCheckAt: (cron.data?.[0] as { executed_at?: string } | undefined)?.executed_at ?? null,
    failedCount: stuck.count ?? 0,
    truncated: ev.truncated || leadsRes.truncated,
  }
}
