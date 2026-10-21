/**
 * Antonio's all-leads workspace (server; TD Marketing, dev job 9aec66fa). Admin pages and admin routes only: the caller has already checked who is asking.
 * Unlike the team screens, nothing here is limited to one team: that is the point of the page.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { LEAD_COLS, type LeadRow, type LeadEventRow } from "@/lib/marketing/leads-read"

export interface LeadFilter { team?: string | "none" | null; stage?: string | null; q?: string | null; limit?: number }

/** A search text made safe for a LIKE pattern (no wildcards of its own). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_,()]/g, " ").replace(/\s+/g, " ").trim()}%`
}

export async function listLeadsFiltered(db: Db, f: LeadFilter): Promise<LeadRow[]> {
  let q = db.from("marketing_leads").select(LEAD_COLS)
  if (f.team === "none") q = q.is("team_id", null)
  else if (f.team) q = q.eq("team_id", f.team)
  if (f.stage) q = q.eq("status", f.stage)
  const text = (f.q ?? "").trim().slice(0, 80)
  if (text.length >= 2) {
    const p = likePattern(text)
    q = q.or(`full_name.ilike.${p},email.ilike.${p},phone.ilike.${p},campaign_name.ilike.${p}`)
  }
  const { data } = await q.order("received_at", { ascending: false }).limit(f.limit ?? 300)
  return (data ?? []) as LeadRow[]
}

export async function getLeadAny(db: Db, id: string): Promise<LeadRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data } = await db.from("marketing_leads").select(LEAD_COLS).eq("id", id).maybeSingle()
  return (data ?? null) as LeadRow | null
}

export async function leadHistory(db: Db, leadId: string): Promise<LeadEventRow[]> {
  const { data } = await db.from("marketing_lead_events").select("id, kind, actor, data, created_at").eq("lead_id", leadId).order("created_at", { ascending: true }).limit(300)
  return (data ?? []) as LeadEventRow[]
}

export type AssignResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

/** Give a lead that has no team to a team (Antonio only). A lead that already has a team is not moved by this: that would hide it from the people working it. */
export async function assignLeadToTeam(db: Db, leadId: string, teamId: string, actor: string): Promise<AssignResult> {
  const lead = await getLeadAny(db, leadId)
  if (!lead) return { ok: false, status: 404, error: "Lead not found." }
  if (lead.team_id) return { ok: false, status: 409, error: "This lead already belongs to a team." }
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) return { ok: false, status: 400, error: "Pick a team." }
  const { data: team } = await db.from("marketing_teams").select("id, name, status").eq("id", teamId).maybeSingle()
  if (!team) return { ok: false, status: 400, error: "Team not found." }
  const upd = await db.from("marketing_leads").update({ team_id: team.id, updated_at: new Date().toISOString() }).eq("id", leadId).is("team_id", null).select("id")
  if (upd.error) return { ok: false, status: 500, error: "Could not save. Please try again." }
  if (!upd.data || upd.data.length === 0) return { ok: false, status: 409, error: "This lead was just given to a team. Reload the page." }
  const ev = await db.from("marketing_lead_events").insert({ lead_id: leadId, kind: "assigned", actor, data: { team_id: team.id, team_name: team.name } })
  if (ev.error) return { ok: false, status: 500, error: "Saved, but the history line could not be written." }
  return { ok: true }
}
