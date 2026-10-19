/**
 * The only place that talks to Meta's Graph API (server; TD Marketing, dev job 9aec66fa).
 * The access token travels in the Authorization header, NEVER in the URL, so no log line can ever carry it.
 * Env: META_PAGE_ACCESS_TOKEN (a long-lived Page or system-user token), META_GRAPH_VERSION (default v25.0), META_PAGE_IDS (comma list, for reconciliation).
 */
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"

const LEAD_FIELDS = "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data"

export class GraphError extends Error {
  constructor(message: string, readonly status: number | null) { super(message) }
}

/** Meta's host. The only other accepted value is a loopback address, so the end-to-end test can stand in a fake Meta; nothing else can redirect our token. */
function origin(): string {
  const o = (process.env.META_GRAPH_BASE_URL || "").trim()
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : "https://graph.facebook.com"
}

function base(): string {
  const v = (process.env.META_GRAPH_VERSION || "v25.0").trim()
  return `${origin()}/${/^v\d+\.\d+$/.test(v) ? v : "v25.0"}`
}

async function graphGet<T>(path: string, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = process.env.META_PAGE_ACCESS_TOKEN
  if (!token) throw new GraphError("META_PAGE_ACCESS_TOKEN is not set", null)
  const qs = new URLSearchParams(params).toString()
  const res = await fetchImpl(`${base()}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  })
  const text = await res.text()
  if (!res.ok) {
    // Meta's error body names the problem (expired token, missing permission); it never echoes our token.
    let detail = ""
    try { detail = JSON.parse(text)?.error?.message ?? "" } catch { /* not JSON */ }
    throw new GraphError(`Graph ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`, res.status)
  }
  return JSON.parse(text) as T
}

export function fetchLead(leadgenId: string, fetchImpl?: typeof fetch): Promise<GraphLead> {
  if (!/^\d{1,30}$/.test(leadgenId)) throw new GraphError("bad leadgen id", null)
  return graphGet<GraphLead>(`/${leadgenId}`, { fields: LEAD_FIELDS }, fetchImpl)
}

export async function listPageForms(pageId: string, fetchImpl?: typeof fetch): Promise<Array<{ id: string; name?: string; status?: string }>> {
  const r = await graphGet<{ data?: Array<{ id: string; name?: string; status?: string }> }>(`/${pageId}/leadgen_forms`, { fields: "id,name,status", limit: "50" }, fetchImpl)
  return r.data ?? []
}

/** Recent leads of one form (newest first, one page of up to 50: enough for a 5-minute reconcile). */
export async function listFormLeads(formId: string, fetchImpl?: typeof fetch): Promise<GraphLead[]> {
  const r = await graphGet<{ data?: GraphLead[] }>(`/${formId}/leads`, { fields: LEAD_FIELDS, limit: "50" }, fetchImpl)
  return r.data ?? []
}

export function configuredPageIds(): string[] {
  return (process.env.META_PAGE_IDS || "").split(",").map(s => s.trim()).filter(s => /^\d{1,30}$/.test(s))
}
