/**
 * Reading the Calendar's data (server; TD Marketing, dev job 9aec66fa, build step 5). Only the team's own leads that have a call back date, and the history rows that set those call backs.
 * The team filter is in every query; the lists are read in pages (the database cuts one answer at 1000 rows) and a failed page fails loudly.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { CalAppointment, CalEvent, CalLead } from "@/lib/marketing/calendar"
import { readPaged } from "@/lib/marketing/paged"

/** how far back the calendar remembers booked calls (they show as done) */
export const HISTORY_DAYS = 35

export async function loadCalendarData(db: Db, teamId: string): Promise<{ leads: CalLead[]; events: CalEvent[]; appointments: CalAppointment[]; truncated: boolean }> {
  const { rows: leads, truncated } = await readPaged<CalLead>((from, to) =>
    db.from("marketing_leads").select("id, full_name, email, ad_name, claimed_by, callback_at, status").eq("team_id", teamId).not("callback_at", "is", null)
      .order("callback_at", { ascending: true }).order("id", { ascending: true }).range(from, to), 5000)
  const events: CalEvent[] = []
  let evCut = false
  for (let i = 0; i < leads.length; i += 100) {
    const chunk = leads.slice(i, i + 100).map(l => l.id)
    const { rows, truncated: t } = await readPaged<CalEvent>((from, to) =>
      db.from("marketing_lead_events").select("lead_id, actor, created_at, data").in("lead_id", chunk).eq("kind", "status_changed").in("data->>outcome", ["call_back", "not_ready"])
        .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), 5000)
    events.push(...rows); evCut = evCut || t
  }
  // calls booked with the seller: the newest "appointment" row of each lead that is not a cancellation and still ahead, then those leads (this team's only)
  const { rows: apRows, truncated: apCut } = await readPaged<{ lead_id: string; actor: string; created_at: string; data: Record<string, unknown> }>((from, to) =>
    db.from("marketing_lead_events").select("lead_id, actor, created_at, data").eq("kind", "appointment").order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), 5000)
  // the time comes from the newest row; the owner is whoever BOOKED it (a row that only moved the call does not take it over)
  const newest = new Map<string, { actor: string; at: string | null; viaViewAs: boolean; actorFinal: boolean }>()
  for (const r of apRows) {
    const moved = r.data?.rescheduled === true
    const cur = newest.get(r.lead_id)
    if (!cur) { newest.set(r.lead_id, { actor: r.actor, at: typeof r.data?.at === "string" ? r.data.at : null, viaViewAs: r.data?.via_view_as === true, actorFinal: !moved }); continue }
    if (!cur.actorFinal && !moved) { cur.actor = r.actor; cur.actorFinal = true }
  }
  // the calls that are still ahead, and the ones of the last five weeks (shown as done)
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString()
  const ahead = Array.from(newest.entries()).filter(([, v]) => v.at && v.at >= since)
  const appointments: CalAppointment[] = []
  for (let i = 0; i < ahead.length; i += 100) {
    const chunk = ahead.slice(i, i + 100)
    const { data, error } = await db.from("marketing_leads").select("id, full_name, email, ad_name, claimed_by, status").eq("team_id", teamId).in("id", chunk.map(([id]) => id))
    if (error) throw new Error(`calendar appointments: ${error.message}`)
    const byId = new Map(((data ?? []) as CalAppointment["lead"][]).map(l => [l.id, l]))
    for (const [id, v] of chunk) { const lead = byId.get(id); if (lead && v.at) appointments.push({ lead, at: v.at, actor: v.actor }) }
  }
  return { leads, events, appointments, truncated: truncated || evCut || apCut }
}
