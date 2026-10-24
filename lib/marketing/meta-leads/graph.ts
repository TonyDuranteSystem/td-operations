/**
 * The only place that talks to Meta's Graph API (server; TD Marketing, dev job 9aec66fa).
 * The access token travels in the Authorization header, NEVER in the URL, so no log line can ever carry it.
 * Which key is used: the Page key saved ENCRYPTED by the "Connect Meta" button (key-store / key-resolver), else the Vercel setting META_PAGE_ACCESS_TOKEN.
 * Env: META_GRAPH_VERSION (default v25.0), META_PAGE_IDS (comma list, for reconciliation).
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

/** Which key to use for a call. Default: the stored (encrypted) Page key, else the Vercel setting. Tests and the connect flow can override it. */
export type KeyResolver = (pageId?: string | null) => Promise<string | null>
const envResolver: KeyResolver = async () => process.env.META_PAGE_ACCESS_TOKEN || null
const defaultResolver: KeyResolver = async pageId => {
  try {
    const m = await import("@/lib/marketing/meta-leads/key-resolver")
    const k = await m.resolveStoredPageKey(pageId)
    if (k) return k
  } catch { /* no database in this context (a unit test, a build step): use the Vercel setting */ }
  return envResolver(pageId)
}
let resolver: KeyResolver = defaultResolver
export function setKeyResolver(fn: KeyResolver | null): void { resolver = fn ?? defaultResolver }
/** For tests: ignore the database, use only the Vercel setting. */
export function useEnvKeyOnly(): void { resolver = envResolver }

interface CallOptions {
  method?: "GET" | "POST"
  /** Use exactly this key (the connect flow works with a personal key). Default: resolve the stored / Vercel Page key. */
  key?: string | null
  pageId?: string | null
  /** Send NO Authorization header (the key exchange authenticates with the app id and secret in its body). */
  noAuth?: boolean
  fetchImpl?: typeof fetch
}

async function graphCall<T>(path: string, params: Record<string, string>, o: CallOptions = {}): Promise<T> {
  const method = o.method ?? "GET"
  const token = o.noAuth ? null : (o.key ?? (await resolver(o.pageId ?? null)))
  if (!o.noAuth && !token) throw new GraphError("The Page access key is not set", null)
  const qs = new URLSearchParams(params).toString()
  const post = method === "POST"
  const res = await (o.fetchImpl ?? fetch)(`${base()}${path}${!post && qs ? `?${qs}` : ""}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
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

const graphGet = <T>(path: string, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch, pageId?: string | null) => graphCall<T>(path, params, { fetchImpl, pageId })

export function fetchLead(leadgenId: string, fetchImpl?: typeof fetch, pageId?: string | null): Promise<GraphLead> {
  if (!/^\d{1,30}$/.test(leadgenId)) throw new GraphError("bad leadgen id", null)
  return graphGet<GraphLead>(`/${leadgenId}`, { fields: LEAD_FIELDS }, fetchImpl, pageId)
}

export async function listPageForms(pageId: string, fetchImpl?: typeof fetch): Promise<Array<{ id: string; name?: string; status?: string }>> {
  const r = await graphGet<{ data?: Array<{ id: string; name?: string; status?: string }> }>(`/${pageId}/leadgen_forms`, { fields: "id,name,status", limit: "50" }, fetchImpl, pageId)
  return r.data ?? []
}

/** Recent leads of one form (newest first, one page of up to 50: enough for a 5-minute reconcile). */
export async function listFormLeads(formId: string, fetchImpl?: typeof fetch, pageId?: string | null): Promise<GraphLead[]> {
  const r = await graphGet<{ data?: GraphLead[] }>(`/${formId}/leads`, { fields: LEAD_FIELDS, limit: "50" }, fetchImpl, pageId)
  return r.data ?? []
}

/**
 * One page of a form's leads, newest first, and the cursor for the next (older) page. Used by the one-time history import
 * (the 5-minute reconcile only needs the first page). `after` is Meta's own opaque cursor, passed back as it came.
 */
export async function listFormLeadsPage(formId: string, after: string | null, fetchImpl?: typeof fetch, pageId?: string | null): Promise<{ leads: GraphLead[]; after: string | null }> {
  if (!/^\d{1,30}$/.test(formId)) throw new GraphError("bad form id", null)
  if (after !== null && !/^[A-Za-z0-9_=+/-]{1,300}$/.test(after)) throw new GraphError("bad cursor", null)
  const r = await graphGet<{ data?: GraphLead[]; paging?: { cursors?: { after?: string }; next?: string } }>(`/${formId}/leads`, { fields: LEAD_FIELDS, limit: "50", ...(after ? { after } : {}) }, fetchImpl, pageId)
  return { leads: r.data ?? [], after: r.paging?.next ? (r.paging.cursors?.after ?? null) : null }
}

export function configuredPageIds(): string[] {
  return (process.env.META_PAGE_IDS || "").split(",").map(s => s.trim()).filter(s => /^\d{1,30}$/.test(s))
}

// ── the connection check and the one-time "subscribe the Page" action (admin screen) ──
const PAGE_ID = /^\d{1,30}$/

/** Who the configured access key belongs to. For a Page access key this is the Page itself. */
export function fetchTokenIdentity(fetchImpl?: typeof fetch, pageId?: string | null): Promise<{ id: string; name?: string }> {
  return graphGet<{ id: string; name?: string }>("/me", { fields: "id,name" }, fetchImpl, pageId)
}

export interface SubscribedApp { id: string; name?: string; subscribed_fields?: string[] }

/** Which apps the Page has installed, and which fields each one receives (we need ours to receive `leadgen`). */
export async function listPageSubscribedApps(pageId: string, fetchImpl?: typeof fetch): Promise<SubscribedApp[]> {
  if (!PAGE_ID.test(pageId)) throw new GraphError("bad page id", null)
  const r = await graphGet<{ data?: SubscribedApp[] }>(`/${pageId}/subscribed_apps`, {}, fetchImpl, pageId)
  return r.data ?? []
}

/** Install our app on the Page so Meta sends us its new leads. Needs a Page access key allowed to advertise/manage that Page. */
export async function subscribePageToLeads(pageId: string, fetchImpl?: typeof fetch): Promise<boolean> {
  if (!PAGE_ID.test(pageId)) throw new GraphError("bad page id", null)
  const r = await graphCall<{ success?: boolean }>(`/${pageId}/subscribed_apps`, { subscribed_fields: "leadgen" }, { method: "POST", pageId, fetchImpl })
  return r.success === true
}

// ── the "Connect Meta" flow: start from a PERSONAL key, end with the Page's own key ──
/** Who a given key belongs to (a person for a personal key, the Page for a Page key). */
export function identityWithKey(key: string, fetchImpl?: typeof fetch): Promise<{ id: string; name?: string }> {
  return graphCall<{ id: string; name?: string }>("/me", { fields: "id,name" }, { key, fetchImpl })
}

export interface Account { id: string; name?: string; access_token?: string }

/** The Pages this personal key manages, each with its own Page key. */
export async function listAccountsWithKey(userKey: string, fetchImpl?: typeof fetch): Promise<Account[]> {
  const r = await graphCall<{ data?: Account[] }>("/me/accounts", { fields: "id,name,access_token", limit: "100" }, { key: userKey, fetchImpl })
  return r.data ?? []
}

/**
 * Turn a personal key into the long-lasting kind (about 60 days). A Page key made from a long-lasting personal key does not expire on a
 * clock. The app id and secret travel in the request BODY (POST), never in a URL; if Meta only accepts the older GET form we fall back to it.
 */
export async function exchangeForLongLived(userKey: string, appId: string, appSecret: string, fetchImpl?: typeof fetch): Promise<{ accessToken: string; expiresIn: number | null }> {
  const params = { grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: userKey }
  const parse = (r: { access_token?: string; expires_in?: number }) => {
    if (!r.access_token) throw new GraphError("Meta did not return a long-lasting key", null)
    return { accessToken: r.access_token, expiresIn: typeof r.expires_in === "number" ? r.expires_in : null }
  }
  try {
    return parse(await graphCall<{ access_token?: string; expires_in?: number }>("/oauth/access_token", params, { method: "POST", noAuth: true, fetchImpl }))
  } catch (e) {
    if (!(e instanceof GraphError) || (e.status !== 404 && e.status !== 405 && e.status !== 400)) throw e
    if (e.code === 190 || e.code === 10 || e.code === 200) throw e // a real refusal about the key: no point retrying another way
    return parse(await graphCall<{ access_token?: string; expires_in?: number }>("/oauth/access_token", params, { method: "GET", noAuth: true, fetchImpl }))
  }
}
