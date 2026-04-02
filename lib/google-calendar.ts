/**
 * Google Calendar API Helper
 * Uses Service Account with Domain-Wide Delegation to access Antonio's calendar.
 *
 * Auth flow (same as google-drive.ts):
 *   1. Decode SA key from GOOGLE_SA_KEY env var (base64-encoded JSON)
 *   2. Build JWT with calendar scopes, exchange for access token
 *   3. Impersonate antonio.durante@tonydurante.us via DWD
 *
 * NOTE: The calendar scope must be granted in Google Workspace Admin Console
 * under Security > API Controls > Domain-Wide Delegation for the Service Account.
 */

import { SignJWT, importPKCS8 } from "jose"

// ─── Configuration ──────────────────────────────────────────

interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

let cachedToken: { token: string; expiresAt: number } | null = null

function getCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured")

  const json = Buffer.from(b64, "base64").toString("utf-8")
  return JSON.parse(json)
}

const SCOPES = "https://www.googleapis.com/auth/calendar"
const IMPERSONATE_EMAIL = "antonio.durante@tonydurante.us"

// ─── Token Management ───────────────────────────────────────

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: SCOPES,
    sub: IMPERSONATE_EMAIL,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google Calendar OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ─── API Helpers ────────────────────────────────────────────

const CALENDAR_API = "https://www.googleapis.com/calendar/v3"

interface CalendarApiOptions {
  method?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
}

async function calendarRequest(
  endpoint: string,
  { method = "GET", params, body }: CalendarApiOptions = {}
) {
  const token = await getAccessToken()
  const url = new URL(`${CALENDAR_API}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (body) {
    headers["Content-Type"] = "application/json"
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (method === "DELETE" && res.status === 204) {
    return { deleted: true }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Calendar API ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

// ─── Public API ─────────────────────────────────────────────

export interface CalendarEvent {
  id: string
  summary: string
  start: { dateTime?: string; date?: string; timeZone?: string }
  end: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: Array<{ email: string; responseStatus?: string }>
  description?: string
  location?: string
  htmlLink?: string
  status?: string
}

/**
 * List upcoming events
 */
export async function listEvents(
  calendarId = "primary",
  daysAhead = 7,
  maxResults = 20,
  timeZone = "America/New_York"
): Promise<CalendarEvent[]> {
  const now = new Date()
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

  const result = await calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    params: {
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(maxResults),
      timeZone,
    },
  })

  return (result as { items?: CalendarEvent[] }).items || []
}

/**
 * Create a new event
 */
export async function createEvent(
  calendarId = "primary",
  event: {
    summary: string
    start_datetime: string
    end_datetime: string
    description?: string
    attendees?: string[]
    location?: string
    timeZone?: string
  }
): Promise<CalendarEvent> {
  const tz = event.timeZone || "America/New_York"

  const body: Record<string, unknown> = {
    summary: event.summary,
    start: { dateTime: event.start_datetime, timeZone: tz },
    end: { dateTime: event.end_datetime, timeZone: tz },
  }
  if (event.description) body.description = event.description
  if (event.location) body.location = event.location
  if (event.attendees?.length) {
    body.attendees = event.attendees.map((email) => ({ email }))
  }

  return calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body,
  }) as Promise<CalendarEvent>
}

/**
 * Update an existing event (PATCH — only changed fields)
 */
export async function updateEvent(
  calendarId = "primary",
  eventId: string,
  updates: {
    summary?: string
    start_datetime?: string
    end_datetime?: string
    description?: string
    attendees?: string[]
    location?: string
    timeZone?: string
  }
): Promise<CalendarEvent> {
  const tz = updates.timeZone || "America/New_York"
  const body: Record<string, unknown> = {}

  if (updates.summary) body.summary = updates.summary
  if (updates.description) body.description = updates.description
  if (updates.location) body.location = updates.location
  if (updates.start_datetime) body.start = { dateTime: updates.start_datetime, timeZone: tz }
  if (updates.end_datetime) body.end = { dateTime: updates.end_datetime, timeZone: tz }
  if (updates.attendees) body.attendees = updates.attendees.map((email) => ({ email }))

  return calendarRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: "PATCH", body }
  ) as Promise<CalendarEvent>
}

/**
 * Delete an event
 */
export async function deleteEvent(
  calendarId = "primary",
  eventId: string
): Promise<void> {
  await calendarRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: "DELETE" }
  )
}

/**
 * Find free time slots within working hours
 */
export async function findFreeSlots(
  durationMinutes = 60,
  daysAhead = 5,
  workingHoursStart = 9,
  workingHoursEnd = 18,
  timeZone = "America/New_York"
): Promise<Array<{ start: string; end: string; duration_minutes: number }>> {
  const events = await listEvents("primary", daysAhead, 100, timeZone)

  // Build busy blocks (as UTC timestamps)
  const busy: Array<{ start: number; end: number }> = events
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      start: new Date(e.start.dateTime || e.start.date || "").getTime(),
      end: new Date(e.end.dateTime || e.end.date || "").getTime(),
    }))
    .filter((b) => !isNaN(b.start) && !isNaN(b.end))

  const slots: Array<{ start: string; end: string; duration_minutes: number }> = []
  const now = new Date()

  for (let d = 0; d < daysAhead; d++) {
    const day = new Date(now)
    day.setDate(day.getDate() + d)

    // Skip weekends
    const dow = day.getDay()
    if (dow === 0 || dow === 6) continue

    // Create working hours boundaries for this day in the target timezone
    // Use a formatter to get the timezone offset
    const dayStr = day.toLocaleDateString("en-CA", { timeZone }) // YYYY-MM-DD
    const dayStart = new Date(`${dayStr}T${String(workingHoursStart).padStart(2, "0")}:00:00`)
    const dayEnd = new Date(`${dayStr}T${String(workingHoursEnd).padStart(2, "0")}:00:00`)

    // Adjust to timezone — approximate by creating date strings
    // Use Intl to get actual offset
    const offsetMs = getTimezoneOffsetMs(day, timeZone)
    const workStart = dayStart.getTime() - offsetMs
    const workEnd = dayEnd.getTime() - offsetMs

    // Start from now if today
    let cursor = d === 0 ? Math.max(now.getTime(), workStart) : workStart

    // Sort busy blocks for this day
    const dayBusy = busy
      .filter((b) => b.end > workStart && b.start < workEnd)
      .sort((a, b) => a.start - b.start)

    for (const block of dayBusy) {
      if (block.start > cursor) {
        const gapMinutes = (block.start - cursor) / 60000
        if (gapMinutes >= durationMinutes) {
          slots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(cursor + durationMinutes * 60000).toISOString(),
            duration_minutes: durationMinutes,
          })
        }
      }
      cursor = Math.max(cursor, block.end)
    }

    // Check remaining time after last event
    if (workEnd > cursor) {
      const gapMinutes = (workEnd - cursor) / 60000
      if (gapMinutes >= durationMinutes) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + durationMinutes * 60000).toISOString(),
          duration_minutes: durationMinutes,
        })
      }
    }
  }

  return slots
}

/**
 * Get timezone offset in milliseconds for a given date and timezone.
 * Positive = ahead of UTC (e.g., CET = +60min = +3600000ms)
 */
function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" })
  const tzStr = date.toLocaleString("en-US", { timeZone })
  return new Date(tzStr).getTime() - new Date(utcStr).getTime()
}
