/**
 * The only place that talks to Meta's Graph API (server; TD Marketing, dev job 9aec66fa).
 * The access token travels in the Authorization header, NEVER in the URL, so no log line can ever carry it.
 * Env: META_PAGE_ACCESS_TOKEN (a long-lived Page or system-user token), META_GRAPH_VERSION (default v25.0), META_PAGE_IDS (comma list, for reconciliation).
 */
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"

const LEAD_FIELDS = "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data"

export class GraphError extends Error {
  /** `status` = the HTTP status (null when we never reached Meta); `code` = Meta's own error code (190 = bad/expired token, 200/10 = missing permission ...). */
  constructor(message: string, readonly status: number | null, readonly code: number | null = null) { super(message) }
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

async function graphCall<T>(method: "GET" | "POST", path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const token = process.env.META_PAGE_ACCESS_TOKEN
  if (!token) throw new GraphError("META_PAGE_ACCESS_TOKEN is not set", null)
  const qs = new URLSearchParams(params).toString()
  const post = method === "POST"
  const res = await fetchImpl(`${base()}${path}${!post && qs ? `?${qs}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(post ? { body: qs } : {}),
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  })
  const text = await res.text()
  if (!res.ok) {
    // Meta's error body names the problem (expired token, missing permission); it never echoes our token.
    let detail = ""
    let code: number | null = null
    try { const e = JSON.parse(text)?.error; detail = e?.message ?? ""; code = typeof e?.code === "number" ? e.code : null } catch { /* not JSON */ }
    throw new GraphError(`Graph ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`, res.status, code)
  }
  return JSON.parse(text) as T
}

const graphGet = <T>(path: string, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch) => graphCall<T>("GET", path, params, fetchImpl)

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

// ── the connection check and the one-time "subscribe the Page" action (admin screen) ──
const PAGE_ID = /^\d{1,30}$/

/** Who the configured access key belongs to. For a Page access key this is the Page itself. */
export function fetchTokenIdentity(fetchImpl?: typeof fetch): Promise<{ id: string; name?: string }> {
  return graphGet<{ id: string; name?: string }>("/me", { fields: "id,name" }, fetchImpl)
}

export interface SubscribedApp { id: string; name?: string; subscribed_fields?: string[] }

/** Which apps the Page has installed, and which fields each one receives (we need ours to receive `leadgen`). */
export async function listPageSubscribedApps(pageId: string, fetchImpl?: typeof fetch): Promise<SubscribedApp[]> {
  if (!PAGE_ID.test(pageId)) throw new GraphError("bad page id", null)
  const r = await graphGet<{ data?: SubscribedApp[] }>(`/${pageId}/subscribed_apps`, {}, fetchImpl)
  return r.data ?? []
}

/** Install our app on the Page so Meta sends us its new leads. Needs a Page access key allowed to advertise/manage that Page. */
export async function subscribePageToLeads(pageId: string, fetchImpl?: typeof fetch): Promise<boolean> {
  if (!PAGE_ID.test(pageId)) throw new GraphError("bad page id", null)
  const r = await graphCall<{ success?: boolean }>("POST", `/${pageId}/subscribed_apps`, { subscribed_fields: "leadgen" }, fetchImpl ?? fetch)
  return r.success === true
}
