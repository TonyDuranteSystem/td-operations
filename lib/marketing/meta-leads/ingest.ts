/**
 * Lead intake (TD Marketing, dev job 9aec66fa). Pure logic over an injected database and an injected Graph fetch, so every branch is
 * unit-tested without a network or a database. The order is the safety property:
 *   1. the notification (ids only) is stored FIRST, as a durable event, so a lead is never lost if anything below fails;
 *   2. the lead is fetched from Meta; a failure leaves the event 'failed' and the cron retries it (and finally gives up LOUDLY, never silently);
 *   3. the lead is written once (unique on Meta's leadgen id), then the event is marked done.
 * A duplicate delivery, a retry or a reconcile of the same lead can never create a second lead.
 */
import { mapGraphLead, normalizeEmail, normalizePhone, type GraphLead, type MappedLead } from "@/lib/marketing/meta-leads/map-lead"
import type { LeadgenEvent } from "@/lib/marketing/meta-leads/parse-webhook"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
export type Db = { from: (t: string) => any }

export const MAX_ATTEMPTS = 8

export interface IngestDeps {
  db: Db
  /** Fetches one lead from Meta. Throws on any failure. */
  fetchLead: (leadgenId: string) => Promise<GraphLead>
  /** The team new leads belong to (null = not assigned yet). */
  resolveTeam: () => Promise<string | null>
  now?: () => Date
}

export type IngestOutcome =
  | { status: "stored"; leadId: string; duplicate: false }
  | { status: "already_done"; leadId: string | null; duplicate: true }
  | { status: "failed" | "gave_up"; error: string }

export interface ClientMatch { contact_ids: string[]; matched_on: string[]; check_failed?: boolean }

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, c => `\\${c}`)
}

function shortError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/\s+/g, " ").slice(0, 400)
}

/** Does this person look like someone who is already a TD client or contact? A HINT for the team (never a merge, never automatic). */
export async function findExistingClient(db: Db, m: Pick<MappedLead, "email" | "phone">): Promise<ClientMatch | null> {
  const ids = new Set<string>()
  const on = new Set<string>()
  try {
    const email = normalizeEmail(m.email)
    if (email) {
      for (const col of ["email", "email_2"]) {
        const { data, error } = await db.from("contacts").select("id").ilike(col, escapeLike(email)).limit(5)
        if (error) throw error
        for (const r of (data ?? []) as Array<{ id: string }>) { ids.add(r.id); on.add("email") }
      }
    }
    const phone = normalizePhone(m.phone)
    const digits = phone ? phone.replace(/\D/g, "") : ""
    if (digits.length >= 8) {
      const tail = digits.slice(-8)
      for (const col of ["phone", "phone_2"]) {
        const { data, error } = await db.from("contacts").select(`id, ${col}`).ilike(col, `%${tail.split("").join("%")}%`).limit(25)
        if (error) throw error
        for (const r of (data ?? []) as Array<Record<string, string | null>>) {
          const d = String(r[col] ?? "").replace(/\D/g, "")
          if (d.endsWith(tail)) { ids.add(String(r.id)); on.add("phone") }
        }
      }
    }
  } catch (e) {
    // A failed check must never lose the lead, and must never read as "not a client": it is flagged for a person to look at.
    console.error("[marketing-leads] client check failed:", shortError(e))
    return { contact_ids: [], matched_on: [], check_failed: true }
  }
  return ids.size ? { contact_ids: Array.from(ids), matched_on: Array.from(on) } : null
}

export interface EventRow { id: string; status: string; attempts: number | null; lead_id: string | null }

/** Store the notification (idempotent on Meta's leadgen id). Returns the row, new or already there. */
export async function recordLeadgenEvent(db: Db, ev: LeadgenEvent, source: "webhook" | "reconcile"): Promise<{ ok: true; row: EventRow } | { ok: false; error: string }> {
  const cols = "id, status, attempts, lead_id"
  const existing = await db.from("marketing_leadgen_events").select(cols).eq("leadgen_id", ev.leadgenId).maybeSingle()
  if (existing.data) return { ok: true, row: existing.data as EventRow }
  const ins = await db.from("marketing_leadgen_events").insert({
    leadgen_id: ev.leadgenId, page_id: ev.pageId, form_id: ev.formId, ad_id: ev.adId, adgroup_id: ev.adgroupId,
    meta_created_time: ev.createdTime, source, status: "pending",
  }).select(cols).single()
  if (ins.data) return { ok: true, row: ins.data as EventRow }
  if (ins.error && ins.error.code === "23505") {
    const again = await db.from("marketing_leadgen_events").select(cols).eq("leadgen_id", ev.leadgenId).maybeSingle()
    if (again.data) return { ok: true, row: again.data as EventRow }
  }
  return { ok: false, error: shortError(ins.error?.message ?? ins.error ?? "could not record the event") }
}

async function markFailed(deps: IngestDeps, leadgenId: string, attempts: number, e: unknown): Promise<IngestOutcome> {
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const next = attempts + 1
  const status = next >= MAX_ATTEMPTS ? "gave_up" : "failed"
  const error = shortError(e)
  await deps.db.from("marketing_leadgen_events").update({ status, attempts: next, last_error: error, updated_at: now }).eq("leadgen_id", leadgenId)
  if (status === "gave_up") console.error(`[marketing-leads] GAVE UP on lead ${leadgenId} after ${next} attempts: ${error}`)
  return { status, error }
}

/**
 * Store the notification, fetch the lead (unless the caller already has it, as the reconcile does), write it once, mark the event done.
 */
export async function ingestLeadgenEvent(deps: IngestDeps, ev: LeadgenEvent, source: "webhook" | "reconcile", prefetched?: GraphLead): Promise<IngestOutcome> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))().toISOString()

  // 1. the durable event (unique on leadgen_id)
  const rec = await recordLeadgenEvent(db, ev, source)
  if (rec.ok === false) return { status: "failed", error: rec.error }
  const evRow = rec.row
  if (evRow.status === "done") return { status: "already_done", leadId: evRow.lead_id ?? null, duplicate: true }
  if (evRow.status === "gave_up") return { status: "gave_up", error: "already gave up on this lead" }
  const attempts = Number(evRow.attempts ?? 0)

  // 2. the lead itself
  let graph: GraphLead
  try { graph = prefetched ?? (await deps.fetchLead(ev.leadgenId)) } catch (e) { return markFailed(deps, ev.leadgenId, attempts, e) }
  let mapped: MappedLead
  try { mapped = mapGraphLead({ ...graph, id: ev.leadgenId }) } catch (e) { return markFailed(deps, ev.leadgenId, attempts, e) }

  // 3. write it once
  try {
    const teamId = await deps.resolveTeam()
    const client = await findExistingClient(db, mapped)
    const found = await db.from("marketing_leads").select("id").eq("leadgen_id", ev.leadgenId).maybeSingle()
    let leadId: string | null = found.data?.id ?? null
    let created = false
    if (!leadId) {
      const ins = await db.from("marketing_leads").insert({
        team_id: teamId, leadgen_id: ev.leadgenId, page_id: ev.pageId, form_id: mapped.formId ?? ev.formId,
        ad_id: mapped.adId ?? ev.adId, ad_name: mapped.adName, adset_id: mapped.adsetId, adset_name: mapped.adsetName,
        campaign_id: mapped.campaignId, campaign_name: mapped.campaignName, platform: mapped.platform, is_organic: mapped.isOrganic,
        meta_created_time: mapped.metaCreatedTime ?? ev.createdTime, full_name: mapped.fullName, email: mapped.email, phone: mapped.phone,
        country: mapped.country, city: mapped.city, answers: mapped.answers, raw: graph, status: "new", existing_client: client,
      }).select("id").single()
      if (ins.error && ins.error.code !== "23505") throw ins.error
      leadId = ins.data?.id ?? (await db.from("marketing_leads").select("id").eq("leadgen_id", ev.leadgenId).maybeSingle()).data?.id ?? null
      created = !ins.error
    }
    if (!leadId) throw new Error("lead row not found after insert")
    if (created) {
      await db.from("marketing_lead_events").insert({ lead_id: leadId, kind: "received", actor: "system", data: { source, team_assigned: !!teamId } })
      if (client) await db.from("marketing_lead_events").insert({ lead_id: leadId, kind: client.check_failed ? "client_check_failed" : "possible_existing_client", actor: "system", data: client })
    }
    await db.from("marketing_leadgen_events").update({ status: "done", lead_id: leadId, processed_at: now, updated_at: now, last_error: null }).eq("leadgen_id", ev.leadgenId)
    return { status: "stored", leadId, duplicate: false }
  } catch (e) {
    return markFailed(deps, ev.leadgenId, attempts, e)
  }
}

/** Retry the events that are still open (a notification whose fetch failed). Oldest first, a handful per run. */
export async function retryOpenEvents(deps: IngestDeps, limit = 20, minAgeMs = 2 * 60 * 1000): Promise<{ tried: number; stored: number; failed: number }> {
  const cutoff = new Date((deps.now ?? (() => new Date()))().getTime() - minAgeMs).toISOString()
  const { data } = await deps.db.from("marketing_leadgen_events").select("leadgen_id, page_id, form_id, ad_id, adgroup_id, meta_created_time")
    .in("status", ["pending", "failed"]).lt("updated_at", cutoff).order("updated_at", { ascending: true }).limit(limit)
  let stored = 0, failed = 0
  for (const r of (data ?? []) as Array<Record<string, string | null>>) {
    const out = await ingestLeadgenEvent(deps, { leadgenId: String(r.leadgen_id), pageId: r.page_id, formId: r.form_id, adId: r.ad_id, adgroupId: r.adgroup_id, createdTime: r.meta_created_time }, "webhook")
    if (out.status === "stored") stored++
    else if (out.status === "failed" || out.status === "gave_up") failed++
  }
  return { tried: (data ?? []).length, stored, failed }
}
