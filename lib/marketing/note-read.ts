/**
 * The newest written note of each lead in a list (server; TD Marketing, dev job 9aec66fa, build step 2). Used for the line under each "Good lead waiting" on Today. The lead ids
 * come from the team's own lead list, so nothing here can reach another team's rows. Chunked so the request stays small, and read in pages (one database answer is cut at 1000 rows).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { readPaged } from "@/lib/marketing/paged"
import { pickLatestNotes, type LatestNote } from "@/lib/marketing/setter-note"

type Row = { lead_id: string; kind: string; actor: string; data: Record<string, unknown>; created_at: string }

export async function loadLatestNotes(db: Db, leadIds: readonly string[]): Promise<Map<string, LatestNote>> {
  const ids = Array.from(new Set(leadIds))
  const rows: Row[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const { rows: got } = await readPaged<Row>((from, to) => db.from("marketing_lead_events").select("lead_id, kind, actor, data, created_at").in("lead_id", chunk).in("kind", ["note", "status_changed"]).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), 5000)
    rows.push(...got)
  }
  return pickLatestNotes(rows)
}
