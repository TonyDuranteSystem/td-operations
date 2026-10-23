/**
 * Real wiring for lead intake (server; TD Marketing, dev job 9aec66fa): the live database, the Graph client, the team a new lead
 * belongs to, and the reconcile that re-reads recent leads from Meta so a missed notification or an outage never loses one.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { configuredPageIds, fetchLead, listFormLeads, listPageForms } from "@/lib/marketing/meta-leads/graph"
import { ingestLeadgenEvent, type Db, type IngestDeps } from "@/lib/marketing/meta-leads/ingest"
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"

export const leadDb = (): Db => supabaseAdmin as unknown as Db

/** The configured team if it exists, else the only ACTIVE team if there is exactly one, else nobody (Antonio assigns later). */
export async function resolveIntakeTeam(db: Db = leadDb()): Promise<string | null> {
  const configured = String((await getMarketingSetting("lead_intake_team_id")) ?? "")
  if (configured) {
    const { data } = await db.from("marketing_teams").select("id").eq("id", configured).maybeSingle()
    if (data?.id) return data.id as string
  }
  const { data } = await db.from("marketing_teams").select("id").eq("status", "active").limit(2)
  return Array.isArray(data) && data.length === 1 ? (data[0].id as string) : null
}

export function liveDeps(): IngestDeps {
  return { db: leadDb(), fetchLead: (id, pageId) => fetchLead(id, undefined, pageId), resolveTeam: () => resolveIntakeTeam() }
}

const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export interface ReconcileResult { pages: number; forms: number; seen: number; stored: number; errors: string[] }

/** Re-read the last days of leads from every configured Page's forms. Anything we already hold is a no-op. */
export async function reconcileRecentLeads(deps: IngestDeps = liveDeps(), pageIds: string[] = configuredPageIds(), now: Date = new Date()): Promise<ReconcileResult> {
  const out: ReconcileResult = { pages: pageIds.length, forms: 0, seen: 0, stored: 0, errors: [] }
  const since = now.getTime() - RECONCILE_WINDOW_MS
  for (const pageId of pageIds) {
    try {
      const forms = await listPageForms(pageId)
      for (const form of forms) {
        out.forms++
        let leads: GraphLead[] = []
        try { leads = await listFormLeads(form.id, undefined, pageId) } catch (e) { out.errors.push(`form ${form.id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); continue }
        for (const lead of leads) {
          const created = lead.created_time ? Date.parse(lead.created_time) : NaN
          if (Number.isFinite(created) && created < since) continue
          out.seen++
          const r = await ingestLeadgenEvent(deps, {
            leadgenId: String(lead.id), pageId, formId: form.id, adId: lead.ad_id ?? null, adgroupId: lead.adset_id ?? null,
            createdTime: Number.isFinite(created) ? new Date(created).toISOString() : null,
          }, "reconcile", lead)
          if (r.status === "stored") out.stored++
        }
      }
    } catch (e) {
      out.errors.push(`page ${pageId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
    }
  }
  return out
}

/** The real wiring of the history import (live Meta, the live database). */
export async function liveImportDeps(): Promise<import("@/lib/marketing/meta-leads/import-history").ImportDeps> {
  const { listFormLeadsPage } = await import("@/lib/marketing/meta-leads/graph")
  const { MASTER_TZ } = await import("@/lib/marketing/master-view")
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: MASTER_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
  const db = leadDb()
  return {
    ingest: liveDeps(), pageIds: configuredPageIds(),
    listForms: (pageId) => listPageForms(pageId),
    listLeadsPage: (formId, after, pageId) => listFormLeadsPage(formId, after, undefined, pageId),
    alreadyHeld: async (ids) => {
      const held = new Set<string>()
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await db.from("marketing_leads").select("leadgen_id").in("leadgen_id", ids.slice(i, i + 100))
        if (error) throw new Error(`lead lookup: ${error.message}`)
        for (const r of (data ?? []) as Array<{ leadgen_id: string }>) held.add(String(r.leadgen_id))
      }
      return held
    },
    dayOf: (d) => fmt.format(d), now: () => new Date(), budgetMs: 40_000,
  }
}
