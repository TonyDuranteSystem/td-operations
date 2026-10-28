/**
 * TD Marketing — Antonio gives a lead to a person of the team (server; dev job 9aec66fa, Addendum H: "Needs you ... Assign to Rocco"). Admin routes only: the caller has already checked who is asking.
 * The same atomic "pick" as when the person picks it himself (nothing changes if somebody picked or moved the lead in the meantime), but the history line is its own kind ("given"), so the person's
 * own "leads picked" count is not inflated by something he did not do. The person must be an active member of the lead's team who may pick leads.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { getLeadAny } from "@/lib/marketing/admin-leads"
import { effectivePermissions, hasPermission } from "@/lib/marketing/permissions"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { listMembers } from "@/lib/marketing/members"
import { personName } from "@/lib/marketing/setter-note"

export interface GiveTarget { id: string; email: string; name: string }

/** The people of the team who may take a lead: active, with the right to pick leads. */
export async function listGiveTargets(teamId: string): Promise<GiveTarget[]> {
  const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Record<string, string[]>
  return (await listMembers(teamId))
    .filter(m => m.status === "active" && m.user_id && m.email && hasPermission(effectivePermissions({ memberRole: m.member_role as "owner" | "member", bundle: m.bundle, bundles, extra: m.permissions }), "leads.pick"))
    .map(m => ({ id: m.user_id as string, email: m.email as string, name: personName(m.email) }))
}

export type GiveResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

export async function giveLeadTo(db: Db, leadId: string, personId: string, by: string, now = new Date()): Promise<GiveResult> {
  const lead = await getLeadAny(db, leadId)
  if (!lead) return { ok: false, status: 404, error: "Lead not found." }
  if (!lead.team_id) return { ok: false, status: 409, error: "This lead has no team yet. Give it to a team first." }
  if ((lead as { claimed_by?: string | null }).claimed_by) return { ok: false, status: 409, error: "Someone already picked this lead. Reload the page." }
  const person = (await listGiveTargets(lead.team_id)).find(p => p.id === personId)
  if (!person) return { ok: false, status: 400, error: "Pick a person of this team who works the leads." }
  const upd = await db.from("marketing_leads").update({ claimed_by: person.id, claimed_by_label: person.email, claimed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", leadId).is("claimed_by", null).select("id")
  if (upd.error) return { ok: false, status: 500, error: "Could not save. Please try again." }
  if (!upd.data || upd.data.length === 0) return { ok: false, status: 409, error: "Someone just picked this lead. Reload the page." }
  const ev = await db.from("marketing_lead_events").insert({ lead_id: leadId, kind: "given", actor: by, data: { to: person.email, to_name: person.name } })
  if (ev.error) return { ok: false, status: 500, error: "Saved, but the history line could not be written." }
  return { ok: true }
}
