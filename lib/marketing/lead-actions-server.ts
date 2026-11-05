/**
 * Writing a lead action (server; TD Marketing, dev job 9aec66fa, Slice 2a). The team id comes from the guard, never from the request, and
 * is part of every query, so another team's lead id finds nothing. The decision is `planLeadAction` (pure); this file only loads the facts,
 * writes the change with a "nothing changed meanwhile" condition, then writes the history row.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { getTeamLead } from "@/lib/marketing/leads-read"
import { loadPrefsAndTakers } from "@/lib/marketing/time-prefs-server"
import { resolveCallHours, sellerForLead } from "@/lib/marketing/time-prefs"
import { ENDS_CALL, leadActionSchema, planLeadAction, type ActionSettings, type Actor, type LeadActionInput, type LeadFacts } from "@/lib/marketing/lead-actions"

export type ActionResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string; code?: "CALL_STANDS"; callAt?: string }

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
  db: Db, teamId: string, leadId: string, input: LeadActionInput, actor: Actor, settings: ActionSettings, now = new Date(), viaViewAs = false, opts: { fromClientLink?: boolean } = {},
): Promise<ActionResult> {
  const lead = await getTeamLead(db, teamId, leadId)
  if (!lead) return { ok: false, status: 404, error: "Lead not found." }
  const facts: LeadFacts = { claimed_by: (lead as { claimed_by?: string | null }).claimed_by ?? null, status: lead.status }
  if (input.action === "reschedule" || input.action === "appointment" || ENDS_CALL.has(input.action)) {
    // what stands NOW: the call back time on the lead, and the newest booking row (a cancelled booking has no time)
    facts.callback_at = (lead as { callback_at?: string | null }).callback_at ?? null
    const { data: ap, error: apErr } = await db.from("marketing_lead_events").select("data").eq("lead_id", lead.id).eq("kind", "appointment").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1)
    if (apErr) return { ok: false, status: 500, error: "Could not check the call. Please try again." }
    const at = (ap as Array<{ data?: { at?: unknown } }> | null)?.[0]?.data?.at
    facts.appointment_at = typeof at === "string" ? at : null
  }
  if (input.action === "appointment" && input.at !== null && facts.claimed_by === null) {
    // booking the free call hands the lead to the seller whose calendar takes it (the person booking it when he is a seller himself, else the team's seller): the same person the calendar write uses
    try {
      const { takers } = await loadPrefsAndTakers(teamId)
      const seller = sellerForLead(takers, actor.id)
      facts.seller = seller ? { id: seller.userId, label: seller.email } : null
    } catch { facts.seller = null /* the call is still saved; the lead just stays unpicked */ }
  }
  if (input.action === "appointment" && input.at === null && lead.status === "booked") {
    // the stage the lead came from when this call was booked: the newest booking line that recorded it, looking back until an earlier cancel
    const { data: evs, error: evsErr } = await db.from("marketing_lead_events").select("data").eq("lead_id", lead.id).eq("kind", "appointment").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(30)
    if (evsErr) return { ok: false, status: 500, error: "Could not check the call. Please try again." }
    for (const e of (evs ?? []) as Array<{ data?: { at?: unknown; from_status?: unknown; from_callback_at?: unknown; handed_to?: unknown } }>) {
      if (e.data?.at === null) break
      if (typeof e.data?.from_status === "string") { facts.booked_from = e.data.from_status; facts.booked_from_callback = typeof e.data.from_callback_at === "string" ? e.data.from_callback_at : null; facts.booked_handed_to = typeof e.data.handed_to === "string" ? e.data.handed_to : null; break }
    }
  }
  // two leads must not hold the same slot with the same seller: checked for a call booked or moved from a person's page (the client's booking link has its own slot rules)
  const newAt = opts.fromClientLink ? null : input.action === "appointment" && input.at !== null && input.replaces !== undefined ? input.at : input.action === "reschedule" && input.target === "appointment" ? input.at : null
  if (newAt !== null && !Number.isNaN(Date.parse(newAt))) {
    const taken = await slotTaken(db, teamId, lead.id, facts.claimed_by, Date.parse(newAt))
    if (taken === null) return { ok: false, status: 500, error: "Could not check the call. Please try again." }
    facts.slot_taken = taken
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

/** Two leads must not hold the same slot on the same seller's calendar: is there another lead whose call STANDS (its newest booking line has a time) within one slot of `atMs` on the calendar this lead's call lands on? The calendar is the one of `sellerForLead` (the lead's picker when he takes calls, else the first person who takes calls), the same rule the Calendar and the Google write use. `null` = the check itself failed. */
async function slotTaken(db: Db, teamId: string, leadId: string, claimedBy: string | null, atMs: number): Promise<boolean | null> {
  const day = 24 * 3600_000
  // booking lines near that time (a wide window, the exact test is below: stored times may be written with different offsets)
  const { data: near, error } = await db.from("marketing_lead_events").select("lead_id, data").eq("kind", "appointment").gte("data->>at", new Date(atMs - day).toISOString()).lte("data->>at", new Date(atMs + day).toISOString())
  if (error) return null
  const ids = Array.from(new Set(((near ?? []) as Array<{ lead_id: string }>).map(e => e.lead_id).filter(id => id !== leadId)))
  if (ids.length === 0) return false
  const { data: others, error: lErr } = await db.from("marketing_leads").select("id, claimed_by").eq("team_id", teamId).in("id", ids)
  if (lErr) return null
  if ((others ?? []).length === 0) return false
  // whose calendar each call lands on, and that seller's slot length (only looked up now that another call is near)
  let takers: Awaited<ReturnType<typeof loadPrefsAndTakers>>["takers"] = [], callHours: Record<string, unknown> = {}
  try { const l = await loadPrefsAndTakers(teamId); takers = l.takers; callHours = l.prefs.callHours as Record<string, unknown> } catch { /* nobody known: every call counts as the same calendar */ }
  const calendarOf = (claimed: string | null) => sellerForLead(takers, claimed)?.userId ?? null
  const mine = calendarOf(claimedBy)
  const slot = resolveCallHours((mine ? callHours[mine] : undefined) as Parameters<typeof resolveCallHours>[0]).slot
  for (const o of others as Array<{ id: string; claimed_by: string | null }>) {
    if (calendarOf(o.claimed_by) !== mine) continue // another seller's calendar
    // does that lead's call still stand? only its newest booking line says
    const { data: evs, error: eErr } = await db.from("marketing_lead_events").select("data, created_at").eq("lead_id", o.id).eq("kind", "appointment").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1)
    if (eErr) return null
    const at = (evs as Array<{ data?: { at?: unknown } }> | null)?.[0]?.data?.at
    if (typeof at === "string" && Math.abs(Date.parse(at) - atMs) < slot * 60_000) return true
  }
  return false
}
