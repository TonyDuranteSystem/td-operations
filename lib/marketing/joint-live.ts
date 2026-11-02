/**
 * TD Marketing — the real services behind the booking link with the owner (server; dev job 0b916784). Builds `JointEnv` (joint-booking.ts) from the real database, Google, Zoom, Gmail and the lead's history.
 * No rule lives here: only the wiring. The lead's call is written through the SAME action every other booked call uses (`applyLeadAction`), so the Calendar, the history and the seller's own free times
 * see it like any other call.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { gmailPost } from "@/lib/gmail"
import { googleApi } from "@/lib/marketing/gcal"
import { zoomApi, zoomConfigured } from "@/lib/zoom"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { loadPrefsAndTakers } from "@/lib/marketing/time-prefs-server"
import { resolveCallHours } from "@/lib/marketing/time-prefs"
import { loadCalendarData } from "@/lib/marketing/calendar-read"
import { applyLeadAction, loadActionSettings } from "@/lib/marketing/lead-actions-server"
import { buildJointMime } from "@/lib/marketing/joint-rules"
import { makeJointStore } from "@/lib/marketing/joint-store"
import { sendMarketingPush } from "@/lib/marketing/push"
import { getTeamLead } from "@/lib/marketing/leads-read"
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { OwnerCallHours } from "@/lib/marketing/settings-schema"
import type { JointEnv } from "@/lib/marketing/joint-booking"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const rawDb = () => supabaseAdmin as unknown as Db

const ACTOR = { id: "client-booking-link", email: "client (booking link)", role: "member" as const }

export function liveJointEnv(): JointEnv {
  const db = rawDb()
  return {
    store: makeJointStore(db),
    gcal: googleApi,
    zoom: zoomApi,
    zoomReady: () => zoomConfigured(),
    now: () => Date.now(),
    baseUrl: APP_BASE_URL,
    async context(teamId) {
      const [{ prefs, takers }, ownerHours] = await Promise.all([loadPrefsAndTakers(teamId), getMarketingSetting("owner_call_hours", teamId)])
      return {
        prefs, takers, ownerHours: ownerHours as OwnerCallHours,
        async sellerAppointments(userId, excludeLeadId) {
          const slotMs = resolveCallHours(prefs.callHours[userId]).slot * 60_000
          const { appointments } = await loadCalendarData(db, teamId)
          const nowMs = Date.now()
          return appointments
            .filter(a => a.lead.id !== excludeLeadId)
            .map(a => Date.parse(a.at))
            .filter(at => !Number.isNaN(at) && at >= nowMs - 3_600_000)
            .map(at => ({ start: at, end: at + slotMs }))
        },
      }
    },
    async lead(teamId, leadId) {
      const l = await getTeamLead(db, teamId, leadId)
      return l ? { id: l.id, full_name: l.full_name, email: l.email, phone: l.phone, country: l.country, claimed_by: (l as { claimed_by?: string | null }).claimed_by ?? null } : null
    },
    async recordCall(teamId, leadId, op) {
      const settings = await loadActionSettings(teamId)
      const input = op.kind === "set" ? { action: "appointment" as const, at: op.at, note: op.note }
        : op.kind === "move" ? { action: "reschedule" as const, target: "appointment" as const, at: op.at, reason: "Moved by the client", note: op.note, from: op.from }
          : { action: "appointment" as const, at: null, note: op.note }
      const r = await applyLeadAction(db, teamId, leadId, input, ACTOR, settings, new Date())
      return r.ok === false ? { ok: false, error: r.error } : { ok: true }
    },
    async recordSynced(leadId, kind, data) {
      await db.from("marketing_lead_events").insert({ lead_id: leadId, kind, actor: ACTOR.email, data })
    },
    async sendMail(to, mail) {
      await gmailPost("/messages/send", { raw: Buffer.from(buildJointMime(to, mail)).toString("base64url") })
    },
    async tellSeller(teamId, sellerUserId, leadId, text) {
      await sendMarketingPush(teamId, [sellerUserId], { title: "Call with Antonio", body: text, url: `/marketing/board?open=${leadId}`, tag: `joint-${leadId}` })
    },
  }
}
