/**
 * Reading the Calendar's data (server; TD Marketing, dev job 9aec66fa, build step 5). Only the team's own leads that have a call back date, and the history rows that set those call backs.
 * The team filter is in every query; the lists are read in pages (the database cuts one answer at 1000 rows) and a failed page fails loudly.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { CalEvent, CalLead } from "@/lib/marketing/calendar"
import { readPaged } from "@/lib/marketing/paged"

export async function loadCalendarData(db: Db, teamId: string): Promise<{ leads: CalLead[]; events: CalEvent[]; truncated: boolean }> {
  const { rows: leads, truncated } = await readPaged<CalLead>((from, to) =>
    db.from("marketing_leads").select("id, full_name, email, ad_name, claimed_by, callback_at").eq("team_id", teamId).not("callback_at", "is", null)
      .order("callback_at", { ascending: true }).order("id", { ascending: true }).range(from, to), 5000)
  const events: CalEvent[] = []
  let evCut = false
  for (let i = 0; i < leads.length; i += 100) {
    const chunk = leads.slice(i, i + 100).map(l => l.id)
    const { rows, truncated: t } = await readPaged<CalEvent>((from, to) =>
      db.from("marketing_lead_events").select("lead_id, actor, created_at, data").in("lead_id", chunk).eq("kind", "status_changed").eq("data->>outcome", "call_back")
        .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), 5000)
    events.push(...rows); evCut = evCut || t
  }
  return { leads, events, truncated: truncated || evCut }
}
