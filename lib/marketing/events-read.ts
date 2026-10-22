/**
 * Reading the team's history rows (server; TD Marketing, dev job 9aec66fa, build step 1). The team filter is in the QUERY (a join to the team's own leads), so another team's rows
 * never take a share of the row cap, the rows are read in pages (the database cuts any single answer at 1000 rows), and when the cap IS reached the caller is told (`truncated`)
 * so a screen can say so instead of quietly showing smaller numbers.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { MasterEvent } from "@/lib/marketing/master-view"
import { readPaged } from "@/lib/marketing/paged"

export const EVENT_CAP = 20000

export async function loadTeamEvents(
  db: Db, teamId: string, opts: { since?: Date | null; kinds?: readonly string[]; cap?: number } = {},
): Promise<{ events: MasterEvent[]; truncated: boolean }> {
  const { rows, truncated } = await readPaged<MasterEvent & { marketing_leads?: unknown }>((from, to) => {
    let q = db.from("marketing_lead_events")
      .select("lead_id, kind, actor, data, created_at, marketing_leads!inner(team_id)")
      .eq("marketing_leads.team_id", teamId)
    if (opts.kinds?.length) q = q.in("kind", [...opts.kinds])
    if (opts.since) q = q.gte("created_at", opts.since.toISOString())
    return q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to)
  }, opts.cap ?? EVENT_CAP)
  return { events: rows.map(({ marketing_leads: _join, ...e }) => { void _join; return e as MasterEvent }), truncated }
}
