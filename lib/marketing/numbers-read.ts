/**
 * Loading what "My numbers" and "Reports" count (server; TD Marketing, dev job 9aec66fa). The team id comes from the guard and is in every query,
 * so another team's rows never reach the counting. The counting itself is `numbers.ts` (pure).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { MasterEvent } from "@/lib/marketing/master-view"
import { loadTeamEvents } from "@/lib/marketing/events-read"
import { readPaged } from "@/lib/marketing/paged"
import { listTeamSales } from "@/lib/marketing/sales-server"
import type { AdLead } from "@/lib/marketing/numbers"
import type { SaleRow } from "@/lib/marketing/sales"

const LEAD_CAP = 5000

/** `truncated` = some leads or history rows were beyond the read limits and are NOT in these numbers: a screen must say so. */
export interface NumbersData { leads: AdLead[]; events: MasterEvent[]; sales: SaleRow[]; truncated: boolean }

export async function loadNumbersData(db: Db, teamId: string): Promise<NumbersData> {
  const [capped, ev, sales] = await Promise.all([
    readPaged<AdLead>((from, to) => db.from("marketing_leads").select("id, ad_name, campaign_name, received_at, meta_created_time").eq("team_id", teamId).order("received_at", { ascending: false }).order("id", { ascending: false }).range(from, to), LEAD_CAP),
    loadTeamEvents(db, teamId, { kinds: ["status_changed"] }),
    listTeamSales(db, teamId, { limit: 2000 }),
  ])
  return { leads: capped.rows, events: ev.events, sales, truncated: capped.truncated || ev.truncated }
}
