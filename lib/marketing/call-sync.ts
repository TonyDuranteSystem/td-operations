/**
 * TD Marketing — writing a booked call into the seller's work Google calendar (server; dev job 9aec66fa, Addendum K, decision 5 of 30 Oct 2026). A call booked, moved or cancelled in Marketing is
 * also an event on the seller's work calendar, so Calendly sees the hour as busy and cannot offer it twice. The rules: only while the switch is on; only on a work mailbox; the event shows only the
 * lead's first name and "Call"; it carries a private mark with the lead's id, and a move or a cancel only ever touches an event that has THAT mark (never any other event); and if Google refuses, the
 * call is still saved (the caller says so on the screen). Everything goes through `GcalApi`, so it is tested with a fake.
 */
import { isWorkMailbox, type GcalApi } from "@/lib/marketing/gcal"

/** What the lead's history remembers of the event Marketing wrote for its call. */
export interface SyncedEvent { eventId: string; actAs: string; calendarId: string }
export type SyncOutcome =
  | { state: "skipped"; reason: "off" | "no_seller" | "no_mailbox" | "nothing_to_remove" }
  | { state: "synced"; event: SyncedEvent | null }
  | { state: "failed"; message: string }

export interface SyncInput {
  api: GcalApi
  /** the switch "write booked calls into the seller's calendar" */
  enabled: boolean
  seller: { email: string | null; label: string } | null
  action: { kind: "set"; startIso: string; minutes: number; zone: string } | { kind: "cancel" }
  leadId: string
  leadName: string
  /** what the history says Marketing wrote last for this lead (null: nothing, or it was removed) */
  existing: SyncedEvent | null
}

const firstWord = (n: string) => (n || "Lead").trim().split(/\s+/)[0].slice(0, 40)

export async function syncCall(i: SyncInput): Promise<SyncOutcome> {
  if (!i.enabled) return { state: "skipped", reason: "off" }
  if (!i.seller) return { state: "skipped", reason: "no_seller" }
  const actAs = i.seller.email
  if (!isWorkMailbox(actAs)) return { state: "skipped", reason: "no_mailbox" }
  const calendarId = "primary"
  // an event is ours only when Google still holds it AND it carries this lead's mark
  const ours = async (e: SyncedEvent): Promise<boolean> => { try { return (await i.api.getEvent(e.actAs, e.calendarId, e.eventId))?.marketingLeadId === i.leadId } catch { return false } }
  try {
    if (i.action.kind === "cancel") {
      if (!i.existing || !(await ours(i.existing))) return { state: "skipped", reason: "nothing_to_remove" }
      await i.api.removeEvent(i.existing.actAs, i.existing.calendarId, i.existing.eventId)
      return { state: "synced", event: null }
    }
    const start = Date.parse(i.action.startIso)
    if (Number.isNaN(start)) return { state: "failed", message: "The call time was not valid." }
    const startIso = new Date(start).toISOString(), endIso = new Date(start + i.action.minutes * 60_000).toISOString()
    const timeZone = i.action.zone
    if (i.existing && i.existing.actAs.toLowerCase() === actAs.toLowerCase() && (await ours(i.existing))) {
      const ev = await i.api.moveEvent(i.existing.actAs, i.existing.calendarId, i.existing.eventId, { startIso, endIso, timeZone })
      return { state: "synced", event: { eventId: ev.id, actAs: i.existing.actAs, calendarId: i.existing.calendarId } }
    }
    // the lead has a new seller, or the old event is gone: take the old one off its calendar (only if it is ours), then write a new one
    if (i.existing && (await ours(i.existing))) { try { await i.api.removeEvent(i.existing.actAs, i.existing.calendarId, i.existing.eventId) } catch { /* the new one is what matters */ } }
    const created = await i.api.createEvent(actAs, calendarId, { title: `${firstWord(i.leadName)} · Call`, startIso, endIso, timeZone, leadId: i.leadId })
    return { state: "synced", event: { eventId: created.id, actAs, calendarId } }
  } catch (e) {
    return { state: "failed", message: e instanceof Error && e.message ? e.message.slice(0, 200) : "Google did not answer." }
  }
}

/** Read what the history says Marketing wrote last: the newest "calendar_synced" entry; a removal clears it. */
export function latestSynced(events: ReadonlyArray<{ kind: string; created_at: string; data: Record<string, unknown> }>): SyncedEvent | null {
  let latest: { created_at: string; data: Record<string, unknown> } | null = null
  for (const e of events) if (e.kind === "calendar_synced" && (!latest || e.created_at >= latest.created_at)) latest = e
  const d = latest?.data
  if (!d || typeof d.event_id !== "string" || typeof d.act_as !== "string" || typeof d.calendar_id !== "string") return null
  return { eventId: d.event_id, actAs: d.act_as, calendarId: d.calendar_id }
}
