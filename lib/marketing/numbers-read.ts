/**
 * Loading what "My numbers" and "Reports" count (server; TD Marketing, dev job 9aec66fa). The team id comes from the guard and is in every query,
 * so another team's rows never reach the counting. The counting itself is `numbers.ts` (pure).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { MasterEvent } from "@/lib/marketing/master-view"
import { listTeamSales } from "@/lib/marketing/sales-server"
import type { AdLead } from "@/lib/marketing/numbers"
import type { SaleRow } from "@/lib/marketing/sales"

export interface NumbersData { leads: AdLead[]; events: MasterEvent[]; sales: SaleRow[] }

export async function loadNumbersData(db: Db, teamId: string): Promise<NumbersData> {
  const [leadsRes, evRes, sales] = await Promise.all([
    db.from("marketing_leads").select("id, ad_name, campaign_name, received_at, meta_created_time").eq("team_id", teamId).order("received_at", { ascending: false }).limit(5000),
    db.from("marketing_lead_events").select("lead_id, kind, actor, data, created_at").eq("kind", "status_changed").order("created_at", { ascending: false }).limit(20000),
    listTeamSales(db, teamId, { limit: 2000 }),
  ])
  const leads = (leadsRes.data ?? []) as AdLead[]
  const ids = new Set(leads.map(l => l.id))
  // history rows belong to leads of THIS team only
  const events = ((evRes.data ?? []) as MasterEvent[]).filter(e => ids.has(e.lead_id))
  return { leads, events, sales }
}
