/**
 * Writing a lead action (server; TD Marketing, dev job 9aec66fa, Slice 2a). The team id comes from the guard, never from the request, and
 * is part of every query, so another team's lead id finds nothing. The decision is `planLeadAction` (pure); this file only loads the facts,
 * writes the change with a "nothing changed meanwhile" condition, then writes the history row.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { getTeamLead } from "@/lib/marketing/leads-read"
import { leadActionSchema, planLeadAction, type ActionSettings, type Actor, type LeadActionInput, type LeadFacts } from "@/lib/marketing/lead-actions"

export type ActionResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

export async function loadActionSettings(teamId: string): Promise<ActionSettings> {
  const [stages, reasons, checklist, outcomeStages, sellerStages, saleStages] = await Promise.all([
    getMarketingSetting("pipeline_stages", teamId), getMarketingSetting("not_in_target_reasons", teamId),
    getMarketingSetting("qualification_checklist", teamId), getMarketingSetting("setter_outcome_stages", teamId), getMarketingSetting("seller_result_stages", teamId), getMarketingSetting("sale_kind_stages", teamId),
  ])
  return { stages, reasons, checklist, outcomeStages, sellerStages, paidStages: Array.from(new Set(Object.values(saleStages as Record<string, string>))) } as ActionSettings
}

export function parseLeadAction(body: unknown): { ok: true; value: LeadActionInput } | { ok: false; error: string } {
  const r = leadActionSchema.safeParse(body)
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, error: "That request is not valid. Reload the page and try again." }
}

export async function applyLeadAction(
  db: Db, teamId: string, leadId: string, input: LeadActionInput, actor: Actor, settings: ActionSettings, now = new Date(), viaViewAs = false,
): Promise<ActionResult> {
  const lead = await getTeamLead(db, teamId, leadId)
  if (!lead) return { ok: false, status: 404, error: "Lead not found." }
  const facts: LeadFacts = { claimed_by: (lead as { claimed_by?: string | null }).claimed_by ?? null, status: lead.status }
  if (input.action === "reschedule") {
    // what stands NOW: the call back time on the lead, and the newest booking row (a cancelled booking has no time)
    facts.callback_at = (lead as { callback_at?: string | null }).callback_at ?? null
    const { data: ap, error: apErr } = await db.from("marketing_lead_events").select("data").eq("lead_id", lead.id).eq("kind", "appointment").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1)
    if (apErr) return { ok: false, status: 500, error: "Could not check the call. Please try again." }
    const at = (ap as Array<{ data?: { at?: unknown } }> | null)?.[0]?.data?.at
    facts.appointment_at = typeof at === "string" ? at : null
  }
  const plan = planLeadAction(input, facts, actor, settings, now)
  if (plan.ok === false) return plan

  const { change } = plan
  if (Object.keys(change.patch).length) {
    // Only write if nobody picked, released or moved the lead since we read it.
    const seenClaim = (lead as { claimed_by?: string | null }).claimed_by ?? null
    let q = db.from("marketing_leads").update({ ...change.patch, updated_at: now.toISOString() }).eq("id", lead.id).eq("team_id", teamId).eq("status", lead.status)
    q = seenClaim === null ? q.is("claimed_by", null) : q.eq("claimed_by", seenClaim)
    const { data, error } = await q.select("id")
    if (error) return { ok: false, status: 500, error: "Could not save. Please try again." }
    if (!data || data.length === 0) return { ok: false, status: 409, error: "This lead changed while you were looking at it. Reload the page and try again." }
  }
  const { error: evErr } = await db.from("marketing_lead_events").insert({ lead_id: lead.id, kind: change.event.kind, actor: actor.email ?? actor.id, data: viaViewAs ? { ...change.event.data, via_view_as: true } : change.event.data })
  if (evErr) return { ok: false, status: 500, error: "Saved, but the history line could not be written. Tell Antonio." }
  return { ok: true }
}
