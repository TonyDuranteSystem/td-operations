/**
 * TD Marketing — after a call is booked, moved or cancelled: write it into the seller's work Google calendar (server; dev job 9aec66fa, Addendum K, decision 5). The call is ALREADY saved when this
 * runs; whatever happens here never fails it. The result comes back as a plain state so the screen can say so ("the call is saved, but Rocco's calendar was not updated"), and every outcome that
 * matters is written in the lead's history. The rules about WHICH events may be touched are in call-sync.ts (an event is only ever changed or removed when it carries this lead's private mark).
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { googleApi, type GcalApi } from "@/lib/marketing/gcal"
import { latestSynced, syncCall } from "@/lib/marketing/call-sync"
import { loadPrefsAndTakers } from "@/lib/marketing/time-prefs-server"
import { memberZone, resolveCallHours, sellerForLead } from "@/lib/marketing/time-prefs"
import { ROME } from "@/lib/marketing/zones"

export interface CalendarNote { state: "skipped" | "synced" | "failed"; message?: string }

export async function syncAfterAppointment(i: { db: Db; teamId: string; leadId: string; actor: string; action: { kind: "set"; at: string } | { kind: "cancel" }; api?: GcalApi }): Promise<CalendarNote> {
  try {
    const { prefs, takers } = await loadPrefsAndTakers(i.teamId)
    if (!prefs.writeThroughEnabled) return { state: "skipped" }
    const { data: lead } = await i.db.from("marketing_leads").select("id, full_name, email, claimed_by").eq("id", i.leadId).eq("team_id", i.teamId).maybeSingle()
    if (!lead) return { state: "skipped" }
    const seller = sellerForLead(takers, (lead as { claimed_by?: string | null }).claimed_by ?? null)
    const { data: past } = await i.db.from("marketing_lead_events").select("kind, created_at, data").eq("lead_id", i.leadId).eq("kind", "calendar_synced").order("created_at", { ascending: false }).limit(5)
    const existing = latestSynced((past ?? []) as Array<{ kind: string; created_at: string; data: Record<string, unknown> }>)
    const hours = resolveCallHours(seller ? prefs.callHours[seller.userId] : undefined)
    const out = await syncCall({
      api: i.api ?? googleApi, enabled: true, seller: seller ? { email: seller.email, label: seller.label } : null,
      action: i.action.kind === "set" ? { kind: "set", startIso: i.action.at, minutes: hours.slot, zone: seller ? memberZone(prefs, seller.userId) : ROME } : { kind: "cancel" },
      leadId: i.leadId, leadName: (lead as { full_name?: string | null }).full_name || "Lead", existing,
    })
    if (out.state === "synced") {
      const wrote = await i.db.from("marketing_lead_events").insert({ lead_id: i.leadId, kind: "calendar_synced", actor: i.actor, data: { event_id: out.event?.eventId ?? null, act_as: out.event?.actAs ?? existing?.actAs ?? null, calendar_id: out.event?.calendarId ?? existing?.calendarId ?? null, removed: out.event === null } })
      // a NEW event whose id could not be written down would never be found again (the next move would make a second one): take it back off the calendar and say so
      if (wrote?.error && out.event && out.event.eventId !== existing?.eventId) {
        try { await (i.api ?? googleApi).removeEvent(out.event.actAs, out.event.calendarId, out.event.eventId) } catch { /* said below */ }
        return { state: "failed", message: "The call was saved, but its calendar entry could not be recorded, so it was not kept on the seller's calendar." }
      }
      return { state: "synced" }
    }
    if (out.state === "failed") {
      await i.db.from("marketing_lead_events").insert({ lead_id: i.leadId, kind: "calendar_sync_failed", actor: i.actor, data: { message: out.message } })
      return { state: "failed", message: out.message }
    }
    // the switch is on but there was nobody to write for: a booking that silently never reaches the seller's calendar is the thing to avoid, so say it (a cancel with nothing to remove is not a problem)
    if (out.reason === "no_seller") return { state: "failed", message: "Nobody is set up to take calls, so nothing was written to a calendar." }
    if (out.reason === "no_mailbox") return { state: "failed", message: "The seller's login is not a company mailbox, so nothing was written to a calendar." }
    return { state: "skipped" }
  } catch { return { state: "failed", message: "Could not update the seller's calendar." } }
}
