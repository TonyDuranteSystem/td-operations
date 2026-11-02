/**
 * Zoom meetings for booked calls (server; dev job 0b916784, 1 Nov 2026). A Server-to-Server OAuth app ("TD Marketing Booking", account-level) lets the system make, move and delete a meeting for ONE
 * booking, with no person signing in. Three keys come from the Zoom app's page and are set as environment variables by Antonio himself (never in code, never in chat): ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
 * ZOOM_CLIENT_SECRET. Meetings are made for ZOOM_HOST_USER (his Zoom login email), "me" when it is not set. Everything goes through `ZoomApi`, so every rule is tested with a fake and no test reaches Zoom.
 */
export interface ZoomMeeting { id: string; joinUrl: string }
export interface ZoomInput { topic: string; startIso: string; minutes: number; timeZone: string }

export interface ZoomApi {
  createMeeting(i: ZoomInput): Promise<ZoomMeeting>
  updateMeeting(id: string, i: Omit<ZoomInput, "topic">): Promise<void>
  /** A meeting that is already gone is not an error. */
  deleteMeeting(id: string): Promise<void>
}

type Env = Record<string, string | undefined>
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

export function zoomConfigured(env: Env = process.env): boolean {
  return Boolean(env.ZOOM_ACCOUNT_ID?.trim() && env.ZOOM_CLIENT_ID?.trim() && env.ZOOM_CLIENT_SECRET?.trim())
}

const short = (t: string) => t.replace(/\s+/g, " ").slice(0, 160)

export function makeZoomApi(env: Env = process.env, fetchFn: FetchFn = fetch as unknown as FetchFn, now: () => number = Date.now): ZoomApi {
  let token: { value: string; until: number } | null = null
  const hostUser = encodeURIComponent((env.ZOOM_HOST_USER ?? "").trim() || "me")

  async function accessToken(): Promise<string> {
    if (token && token.until > now() + 60_000) return token.value
    if (!zoomConfigured(env)) throw new Error("Zoom is not set up yet.")
    const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString("base64")
    const r = await fetchFn(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(String(env.ZOOM_ACCOUNT_ID))}`, { method: "POST", headers: { Authorization: `Basic ${basic}` } })
    if (!r.ok) throw new Error(`Zoom refused the login (${r.status}).`)
    const j = (await r.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw new Error("Zoom did not give an access token.")
    token = { value: j.access_token, until: now() + (j.expires_in ?? 3600) * 1000 }
    return token.value
  }

  async function call(path: string, init: { method: string; body?: unknown }): Promise<{ status: number; json: unknown }> {
    const t = await accessToken()
    const r = await fetchFn(`https://api.zoom.us/v2${path}`, { method: init.method, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })
    if (r.status === 401) token = null // an old token: the next call asks for a new one
    if (!r.ok && !(init.method === "DELETE" && r.status === 404)) throw new Error(`Zoom answered ${r.status}: ${short(await r.text().catch(() => ""))}`)
    return { status: r.status, json: r.status === 204 || r.status === 404 ? null : await r.json().catch(() => null) }
  }

  const body = (i: Omit<ZoomInput, "topic">) => ({ start_time: new Date(i.startIso).toISOString().replace(/\.\d{3}Z$/, "Z"), duration: i.minutes, timezone: i.timeZone })

  return {
    async createMeeting(i) {
      const r = await call(`/users/${hostUser}/meetings`, { method: "POST", body: { topic: i.topic, type: 2, ...body(i), settings: { waiting_room: true, join_before_host: false, host_video: true, participant_video: true } } })
      const j = r.json as { id?: number | string; join_url?: string } | null
      if (!j?.id || !j.join_url) throw new Error("Zoom did not return the meeting it made.")
      return { id: String(j.id), joinUrl: j.join_url }
    },
    async updateMeeting(id, i) { await call(`/meetings/${encodeURIComponent(id)}`, { method: "PATCH", body: body(i) }) },
    async deleteMeeting(id) { await call(`/meetings/${encodeURIComponent(id)}?schedule_for_reminder=false`, { method: "DELETE" }) },
  }
}

export const zoomApi: ZoomApi = makeZoomApi()
