/**
 * TD Marketing — Google Calendar for the calendar features (server; dev job 9aec66fa, Addendum K, B3 and B5). The service account (domain-wide delegation) acts as a person of the company's Google
 * Workspace: Antonio for his own calendar, the seller for his work calendar and the free/busy question about his personal one. Everything here goes through `GcalApi`, so every rule is tested
 * with a fake and no test ever reaches Google. The rules that matter:
 *   - the service account only ever acts as a mailbox of the company domain (a personal Gmail is never impersonated; it is read as a calendar SHARED into a work mailbox);
 *   - a personal calendar is only asked "when is he busy" (free/busy), never for event titles, and only when it is shared as "free/busy only";
 *   - Marketing only ever changes or removes an event IT CREATED (marked with a private property), never anything else on a calendar.
 */
import { calendarRequestAs } from "@/lib/google-calendar"
import type { GoogleItem } from "@/lib/marketing/calendar-visibility"

/** Only a mailbox of the company can be acted as. */
export const isWorkMailbox = (e: unknown): e is string => typeof e === "string" && /^[a-z0-9._+-]{1,64}@tonydurante\.us$/i.test(e.trim())

export interface GEvent { id: string; calendarId: string; title: string; startMs: number; endMs: number; guests: string[]; allDay: boolean; /** set on the events Marketing created for a booked call */ marketingLeadId: string | null }
export interface GCalendarEntry { id: string; accessRole: string; primary: boolean }
export interface GBusy { start: number; end: number }
export interface GFreeBusy { busy: GBusy[]; /** a reason Google gave for not answering ("notFound": the calendar is not shared with this mailbox) */ error: string | null }

export interface GEventInput { title: string; startIso: string; endIso: string; timeZone: string; leadId?: string }

/** The few things Marketing asks of Google. Real implementation below; tests pass a fake. */
export interface GcalApi {
  calendarList(actAs: string): Promise<GCalendarEntry[]>
  freeBusy(actAs: string, calendarIds: string[], timeMinIso: string, timeMaxIso: string): Promise<Record<string, GFreeBusy>>
  listEvents(actAs: string, calendarId: string, timeMinIso: string, timeMaxIso: string): Promise<GEvent[]>
  getEvent(actAs: string, calendarId: string, eventId: string): Promise<GEvent | null>
  createEvent(actAs: string, calendarId: string, input: GEventInput): Promise<GEvent>
  moveEvent(actAs: string, calendarId: string, eventId: string, input: { startIso: string; endIso: string; timeZone: string }): Promise<GEvent>
  removeEvent(actAs: string, calendarId: string, eventId: string): Promise<void>
}

type RawEvent = {
  id: string; status?: string; summary?: string; transparency?: string
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string; resource?: boolean }>
  extendedProperties?: { private?: Record<string, string> }
}

/** One Google event in the shape Marketing uses; null for one that is cancelled or has no usable time. */
export function eventFromGoogle(raw: RawEvent, calendarId: string): GEvent | null {
  if (!raw || raw.status === "cancelled") return null
  const allDay = !raw.start?.dateTime
  const startMs = Date.parse(raw.start?.dateTime ?? raw.start?.date ?? "")
  const endMs = Date.parse(raw.end?.dateTime ?? raw.end?.date ?? "")
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null
  return {
    id: raw.id, calendarId, title: (raw.summary ?? "").trim() || "(no title)", startMs, endMs, allDay,
    guests: (raw.attendees ?? []).filter(a => !a.resource).map(a => a.email).filter(Boolean),
    marketingLeadId: raw.extendedProperties?.private?.td_marketing_call ?? null,
  }
}

const CAL = "/calendars"
const enc = encodeURIComponent

/** The real thing: the service account acting as `actAs` (a mailbox of the company). */
export const googleApi: GcalApi = {
  async calendarList(actAs) {
    const r = (await calendarRequestAs(actAs, "/users/me/calendarList", { params: { minAccessRole: "freeBusyReader", maxResults: "250" } })) as { items?: Array<{ id: string; accessRole: string; primary?: boolean }> }
    return (r.items ?? []).map(i => ({ id: i.id, accessRole: i.accessRole, primary: i.primary === true }))
  },
  async freeBusy(actAs, calendarIds, timeMinIso, timeMaxIso) {
    const r = (await calendarRequestAs(actAs, "/freeBusy", { method: "POST", body: { timeMin: timeMinIso, timeMax: timeMaxIso, items: calendarIds.map(id => ({ id })) } })) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }> }
    const out: Record<string, GFreeBusy> = {}
    for (const id of calendarIds) {
      const c = r.calendars?.[id]
      out[id] = { busy: (c?.busy ?? []).map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter(b => !Number.isNaN(b.start) && !Number.isNaN(b.end)), error: c?.errors?.[0]?.reason ?? (c ? null : "notFound") }
    }
    return out
  },
  async listEvents(actAs, calendarId, timeMinIso, timeMaxIso) {
    const r = (await calendarRequestAs(actAs, `${CAL}/${enc(calendarId)}/events`, { params: { timeMin: timeMinIso, timeMax: timeMaxIso, singleEvents: "true", orderBy: "startTime", maxResults: "250" } })) as { items?: RawEvent[] }
    return (r.items ?? []).map(e => eventFromGoogle(e, calendarId)).filter((e): e is GEvent => e !== null)
  },
  async getEvent(actAs, calendarId, eventId) {
    try { return eventFromGoogle((await calendarRequestAs(actAs, `${CAL}/${enc(calendarId)}/events/${enc(eventId)}`)) as RawEvent, calendarId) } catch (e) { if (/Calendar API 404/.test(String((e as Error).message))) return null; throw e }
  },
  async createEvent(actAs, calendarId, input) {
    const body: Record<string, unknown> = { summary: input.title, start: { dateTime: input.startIso, timeZone: input.timeZone }, end: { dateTime: input.endIso, timeZone: input.timeZone } }
    if (input.leadId) body.extendedProperties = { private: { td_marketing_call: input.leadId } }
    const ev = eventFromGoogle((await calendarRequestAs(actAs, `${CAL}/${enc(calendarId)}/events`, { method: "POST", body })) as RawEvent, calendarId)
    if (!ev) throw new Error("Google did not return the event it created.")
    return ev
  },
  async moveEvent(actAs, calendarId, eventId, input) {
    const body = { start: { dateTime: input.startIso, timeZone: input.timeZone }, end: { dateTime: input.endIso, timeZone: input.timeZone } }
    const ev = eventFromGoogle((await calendarRequestAs(actAs, `${CAL}/${enc(calendarId)}/events/${enc(eventId)}`, { method: "PATCH", body })) as RawEvent, calendarId)
    if (!ev) throw new Error("Google did not return the event it changed.")
    return ev
  },
  async removeEvent(actAs, calendarId, eventId) { await calendarRequestAs(actAs, `${CAL}/${enc(calendarId)}/events/${enc(eventId)}`, { method: "DELETE" }) },
}

// ── the share check ─────────────────────────────────────────────────────────────────────────────

export type ShareState = "free_busy" | "wide" | "missing" | "error"
export interface ShareResult { id: string; state: ShareState; /** Google's own word for the access level, when the calendar is in the list */ access: string | null }

/**
 * Is each personal calendar shared with the work mailbox as "free/busy only" (Google's `freeBusyReader`)? Anything wider ("See event details", "Make changes") is refused: Marketing never wants
 * to be able to read or change a personal calendar. Not in the list at all = not shared (or not accepted yet).
 */
export function shareResults(list: readonly GCalendarEntry[], personalIds: readonly string[]): ShareResult[] {
  return personalIds.map(id => {
    const hit = list.find(c => c.id.toLowerCase() === id.toLowerCase())
    if (!hit) return { id, state: "missing" as const, access: null }
    return { id, state: hit.accessRole === "freeBusyReader" ? ("free_busy" as const) : ("wide" as const), access: hit.accessRole }
  })
}

/** Ask Google about each personal calendar; a failure to ask is its own answer (the screen says it could not check, and nothing is shown as free). */
export async function checkShare(api: GcalApi, actAs: string | null, personalIds: readonly string[]): Promise<ShareResult[]> {
  if (personalIds.length === 0) return []
  if (!isWorkMailbox(actAs)) return personalIds.map(id => ({ id, state: "error" as const, access: null }))
  try { return shareResults(await api.calendarList(actAs), personalIds) } catch { return personalIds.map(id => ({ id, state: "error" as const, access: null })) }
}

/** The personal calendars are fine to use only when there is nothing to protect or every one is "free/busy only". */
export const shareOk = (rs: readonly ShareResult[]): boolean => rs.every(r => r.state === "free_busy")

// ── items for the Calendar ──────────────────────────────────────────────────────────────────────

/** An event of a calendar as the Calendar's item (all-day events are not drawn on an hour grid; their time still blocks slots through free/busy). */
export function itemFromEvent(e: GEvent, kind: GoogleItem["kind"], prefix: string): GoogleItem | null {
  if (e.allDay) return null
  return { id: `${prefix}:${e.id}`, kind, start: e.startMs, end: e.endMs, title: e.title, guests: e.guests }
}

/** A busy block of a free/busy answer as the Calendar's item (no title: Google never gave one). */
export function itemFromBusy(b: GBusy, kind: GoogleItem["kind"], prefix: string, i: number): GoogleItem {
  return { id: `${prefix}:busy${i}:${b.start}`, kind, start: b.start, end: b.end, title: "Busy", guests: [] }
}
