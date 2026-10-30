/**
 * TD Marketing — the owner's own Google calendar on his page (server; dev job 9aec66fa, Addendum K, B3). He can ADD an event and MOVE one; there is no delete anywhere. Moving an event that has
 * guests is refused until he has been asked and said yes (the server enforces it, not just the screen). Everything goes through `GcalApi`, so it is tested with a fake.
 */
import { isWorkMailbox, type GcalApi } from "@/lib/marketing/gcal"

export type OwnerResult<T = undefined> = { ok: true; data: T } | { ok: false; status: 400 | 404 | 409 | 502; error: string; code?: "GUESTS"; guests?: string[] }
const DAY = 24 * 3600_000

const validIso = (v: unknown): number | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null)

export async function addOwnerEvent(api: GcalApi, ownerEmail: string | null, zone: string, i: { title: unknown; startIso: unknown; endIso: unknown }): Promise<OwnerResult<{ id: string }>> {
  if (!isWorkMailbox(ownerEmail)) return { ok: false, status: 400, error: "Your Google calendar is not connected for this login." }
  const title = typeof i.title === "string" ? i.title.trim() : ""
  if (!title || title.length > 200) return { ok: false, status: 400, error: "Give the event a title (up to 200 letters)." }
  const s = validIso(i.startIso), e = validIso(i.endIso)
  if (s === null || e === null || e <= s) return { ok: false, status: 400, error: "Pick a day, a start and a length." }
  if (e - s > DAY) return { ok: false, status: 400, error: "An event can be at most one day long." }
  try {
    const ev = await api.createEvent(ownerEmail, "primary", { title, startIso: new Date(s).toISOString(), endIso: new Date(e).toISOString(), timeZone: zone })
    return { ok: true, data: { id: ev.id } }
  } catch { return { ok: false, status: 502, error: "Google did not accept the event. Nothing was added; try again." } }
}

export async function moveOwnerEvent(api: GcalApi, ownerEmail: string | null, zone: string, id: string, i: { startIso: unknown; confirmGuests?: unknown }): Promise<OwnerResult<{ id: string }>> {
  if (!isWorkMailbox(ownerEmail)) return { ok: false, status: 400, error: "Your Google calendar is not connected for this login." }
  if (!/^[a-z0-9_]{5,1024}$/i.test(id)) return { ok: false, status: 404, error: "That event could not be found." }
  const start = validIso(i.startIso)
  if (start === null) return { ok: false, status: 400, error: "Pick a day and a time." }
  let ev
  try { ev = await api.getEvent(ownerEmail, "primary", id) } catch { return { ok: false, status: 502, error: "Google could not be reached. Nothing was changed; try again." } }
  if (!ev) return { ok: false, status: 404, error: "That event could not be found. It may have been removed." }
  if (ev.allDay) return { ok: false, status: 400, error: "An all-day event cannot be moved here." }
  // an event with guests is changed on THEIR calendars too: ask first
  if (ev.guests.length > 0 && i.confirmGuests !== true) return { ok: false, status: 409, code: "GUESTS", guests: ev.guests, error: `This event has ${ev.guests.length === 1 ? "a guest" : "guests"}: ${ev.guests.join(", ")}. Moving it changes it on their calendar too. Move it anyway?` }
  try {
    const moved = await api.moveEvent(ownerEmail, "primary", id, { startIso: new Date(start).toISOString(), endIso: new Date(start + (ev.endMs - ev.startMs)).toISOString(), timeZone: zone })
    return { ok: true, data: { id: moved.id } }
  } catch { return { ok: false, status: 502, error: "Google did not accept the change. The event was not moved; try again." } }
}
