/**
 * Calendly API — the READ side the Booking page uses (Stage 1b of the Booking page, dev job 19d2654a).
 *
 * Rules this file keeps (each one has a test):
 *   - Every call goes through an injected HTTP client, so the tests never touch the network.
 *   - The address of every call is built HERE from the API base + a fixed path + a uuid that passed a strict check. An address stored in the database
 *     (a booking's event address) is never fetched as it is: only its uuid is taken out of it, so the bearer token can never be sent to another host.
 *   - An error carries the status code and a short plain kind, NEVER the body Calendly answered with (a body can echo what we sent).
 *   - The token is the existing environment variable CALENDLY_PAT. No token = a plain "not configured" error before any request is made.
 *
 * The WRITE calls (make a one-time link, cancel a booking) live in `lib/calendly/api-write.ts` on purpose: only the Booking page's own code imports that file —
 * never the MCP tools or the Slack worker (a test pins this).
 */

export const CALENDLY_API = "https://api.calendly.com"

export interface CalendlyHttpRequest {
  method: "GET" | "POST"
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}
export interface CalendlyHttpResponse {
  status: number
  json(): Promise<unknown>
}
export type CalendlyHttp = (req: CalendlyHttpRequest) => Promise<CalendlyHttpResponse>

export interface CalendlyCtx {
  http: CalendlyHttp
  /** the personal access token; null = not configured */
  token: string | null
}

export type CalendlyErrorKind = "not_configured" | "auth" | "forbidden" | "not_found" | "rate_limited" | "bad_request" | "server" | "network" | "bad_response"

export class CalendlyError extends Error {
  readonly kind: CalendlyErrorKind
  readonly status: number | null
  /**
   * A short, SAFE hint of what Calendly objected to ("Invalid Argument; parameters: tracking.utm_campaign"): only its title and the NAMES of the parameters it names, never its
   * message text (a message can echo what we sent). For staff-facing reports only; it is never shown to a visitor.
   */
  detail: string | null = null
  constructor(kind: CalendlyErrorKind, status: number | null, message: string) {
    super(message)
    this.name = "CalendlyError"
    this.kind = kind
    this.status = status
  }
}

/** The safe hint of an error answer: Calendly's own title (at most 80 plain characters) and up to 5 parameter names. Anything else in the answer is ignored. */
export function safeErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const title = typeof b.title === "string" ? b.title.replace(/[^\w .,'()/-]/g, "").trim().slice(0, 80) : ""
  const params: string[] = []
  if (Array.isArray(b.details)) {
    for (const d of b.details) {
      const p = d && typeof d === "object" ? (d as Record<string, unknown>).parameter : null
      if (typeof p === "string" && /^[A-Za-z0-9_.[\]-]{1,60}$/.test(p) && params.length < 5) params.push(p)
    }
  }
  const out = [title, params.length ? `parameters: ${params.join(", ")}` : ""].filter(Boolean).join("; ")
  return out || null
}

/** The real client: fetch with a timeout. Tests pass their own. */
export const defaultCalendlyHttp: CalendlyHttp = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs), cache: "no-store" })
  return { status: res.status, json: () => res.json() }
}

export function calendlyCtxFromEnv(env: Record<string, string | undefined> = process.env, http: CalendlyHttp = defaultCalendlyHttp): CalendlyCtx {
  const token = (env.CALENDLY_PAT ?? "").trim()
  return { http, token: token || null }
}

// ─── addresses: only ever rebuilt from a strict uuid ───────────────────────────

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EVENT_URI_RE = /^https:\/\/api\.calendly\.com\/scheduled_events\/([0-9a-fA-F-]{36})$/
const EVENT_TYPE_URI_RE = /^https:\/\/api\.calendly\.com\/event_types\/([0-9a-fA-F-]{36})$/

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

/** The uuid inside a Calendly scheduled-event address, or null when the text is anything else (another host, a path, a query...). */
export function eventUuidOf(uri: unknown): string | null {
  if (typeof uri !== "string") return null
  const m = EVENT_URI_RE.exec(uri.trim())
  return m && isUuid(m[1]) ? m[1].toLowerCase() : null
}

export function eventTypeUuidOf(uri: unknown): string | null {
  if (typeof uri !== "string") return null
  const m = EVENT_TYPE_URI_RE.exec(uri.trim())
  return m && isUuid(m[1]) ? m[1].toLowerCase() : null
}

/** The canonical address of an event type, from a uuid that passed the check. */
export function eventTypeUri(uuid: string): string {
  return `${CALENDLY_API}/event_types/${uuid}`
}

// ─── the one request function ───────────────────────────────────────────────────

const TIMEOUT_MS = 10_000

function errorForStatus(status: number): CalendlyError {
  if (status === 401) return new CalendlyError("auth", status, "Calendly did not accept the app's key (401).")
  if (status === 403) return new CalendlyError("forbidden", status, "Calendly says the app's key is not allowed to do this (403).")
  if (status === 404) return new CalendlyError("not_found", status, "Calendly could not find it (404).")
  if (status === 429) return new CalendlyError("rate_limited", status, "Calendly asked us to slow down (429). Try again in a minute.")
  if (status >= 500) return new CalendlyError("server", status, `Calendly had a problem on its side (${status}).`)
  return new CalendlyError("bad_request", status, `Calendly did not accept the request (${status}).`)
}

/**
 * Sends one request to the Calendly API. `path` must start with "/" and is joined to the API base here; it is built by the callers in this folder from fixed
 * words and a checked uuid, never from stored text. Returns the parsed JSON body of a 2xx answer. Throws CalendlyError otherwise (status code only).
 */
export async function calendlyRequest(ctx: CalendlyCtx, method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
  if (!ctx.token) throw new CalendlyError("not_configured", null, "Calendly is not connected on this server (no key set).")
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || /[\s?#]/.test(path)) throw new CalendlyError("bad_request", null, "The Calendly address was not valid.")
  // the query is built from fixed keys and values the callers have checked; it is encoded here, never pasted into the path
  const url = `${CALENDLY_API}${path}${query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`
  let res: CalendlyHttpResponse
  try {
    res = await ctx.http({
      method,
      url,
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: TIMEOUT_MS,
    })
  } catch {
    throw new CalendlyError("network", null, "Calendly could not be reached. Try again in a moment.")
  }
  if (res.status < 200 || res.status >= 300) {
    const err = errorForStatus(res.status)
    try {
      err.detail = safeErrorDetail(await res.json())
    } catch {
      /* no readable answer: the status alone has to do */
    }
    throw err
  }
  try {
    return await res.json()
  } catch {
    throw new CalendlyError("bad_response", res.status, "Calendly answered something we could not read.")
  }
}

// ─── reads ──────────────────────────────────────────────────────────────────────

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

export interface CalendlyEventFacts {
  uri: string
  /** "active" | "canceled" as Calendly says it; anything else is kept as text */
  status: string
  startTime: string | null
  endTime: string | null
  name: string | null
  /** who cancelled it, as Calendly records it ("host" | "invitee"); null = not cancelled, or Calendly did not say */
  cancelerType: string | null
}

/** One scheduled event. `eventUri` is the address we stored for a booking; only its uuid is used. */
export async function getScheduledEvent(ctx: CalendlyCtx, eventUri: string): Promise<CalendlyEventFacts> {
  const uuid = eventUuidOf(eventUri)
  if (!uuid) throw new CalendlyError("bad_request", null, "That booking's Calendly address was not valid.")
  const json = await calendlyRequest(ctx, "GET", `/scheduled_events/${uuid}`)
  const r = isRec(json) && isRec(json.resource) ? json.resource : null
  const status = r ? str(r.status) : null
  if (!r || !status) throw new CalendlyError("bad_response", 200, "Calendly answered something we could not read.")
  const cancellation = isRec(r.cancellation) ? r.cancellation : null
  return {
    uri: str(r.uri) ?? `${CALENDLY_API}/scheduled_events/${uuid}`,
    status,
    startTime: str(r.start_time),
    endTime: str(r.end_time),
    name: str(r.name),
    cancelerType: cancellation ? str(cancellation.canceler_type) : null,
  }
}

/** One question the booker is asked on the Calendly booking page. */
export interface CalendlyQuestion {
  text: string
  required: boolean
}

export interface CalendlyEventTypeFacts {
  uri: string
  name: string | null
  active: boolean
  schedulingUrl: string | null
  durationMinutes: number | null
  /** the questions the booker sees, in Calendly's order; a switched-off question is left out */
  questions: CalendlyQuestion[]
  /** where the call happens, as Calendly names the kinds ("zoom_conference", "google_conference", "physical", ...); in Calendly's order */
  locationKinds: string[]
}

/** The enabled questions of an event type. Anything that is not a readable list gives none. */
export function questionsOf(raw: unknown): CalendlyQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((q): q is Record<string, unknown> => isRec(q) && q.enabled !== false && typeof q.name === "string" && q.name.trim() !== "")
    .sort((a, b) => (typeof a.position === "number" ? a.position : 0) - (typeof b.position === "number" ? b.position : 0))
    .map((q) => ({ text: (q.name as string).trim(), required: q.required === true }))
}

export async function getEventType(ctx: CalendlyCtx, eventTypeUriText: string): Promise<CalendlyEventTypeFacts> {
  const uuid = eventTypeUuidOf(eventTypeUriText)
  if (!uuid) throw new CalendlyError("bad_request", null, "That Calendly event address was not valid.")
  const json = await calendlyRequest(ctx, "GET", `/event_types/${uuid}`)
  const r = isRec(json) && isRec(json.resource) ? json.resource : null
  if (!r) throw new CalendlyError("bad_response", 200, "Calendly answered something we could not read.")
  return {
    uri: str(r.uri) ?? eventTypeUri(uuid),
    name: str(r.name),
    active: r.active === true,
    schedulingUrl: str(r.scheduling_url),
    durationMinutes: typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null,
    questions: questionsOf(r.custom_questions),
    locationKinds: Array.isArray(r.locations) ? r.locations.map((l) => (isRec(l) ? str(l.kind) : null)).filter((k): k is string => !!k) : [],
  }
}

/**
 * The free times of one event type between two moments (Calendly: at most 31 days apart, the start not in the past). Returns the start of each free time as an ISO
 * text in UTC, earliest first. Only a time Calendly calls "available" is kept.
 */
export async function listAvailableTimes(ctx: CalendlyCtx, eventTypeUriText: string, range: { start: Date; end: Date }): Promise<string[]> {
  const uuid = eventTypeUuidOf(eventTypeUriText)
  if (!uuid) throw new CalendlyError("bad_request", null, "That Calendly event address was not valid.")
  const json = await calendlyRequest(ctx, "GET", "/event_type_available_times", undefined, {
    event_type: eventTypeUri(uuid),
    start_time: range.start.toISOString(),
    end_time: range.end.toISOString(),
  })
  const list = isRec(json) && Array.isArray(json.collection) ? json.collection : null
  if (!list) throw new CalendlyError("bad_response", 200, "Calendly answered something we could not read.")
  const out: string[] = []
  for (const t of list) {
    if (!isRec(t) || t.status !== "available") continue
    const s = str(t.start_time)
    if (s && Number.isFinite(Date.parse(s))) out.push(new Date(s).toISOString())
  }
  return Array.from(new Set(out)).sort()
}
