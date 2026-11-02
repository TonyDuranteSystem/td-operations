/**
 * TD Marketing — the database side of the booking link with the owner (server; dev job 0b916784). One table, marketing_joint_links. A time is HELD by the exclusion constraint on (lock_from, lock_to): the database
 * itself refuses a second hold on an overlapping time (code 23P01), so two clients pressing Confirm together cannot both win. Only the hash of a link's token is ever stored.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import type { Interval } from "@/lib/marketing/free-slots"
import { isOverlapViolation } from "@/lib/marketing/joint-rules"
import type { HoldRange, HoldResult, JointStore, LinkRecord } from "@/lib/marketing/joint-booking"

const COLS = "id, team_id, lead_id, seller_user_id, lang, status, expires_at, revoked_at, starts_at, ends_at, client_name, client_email, client_zone, zoom_meeting_id, zoom_join_url, gcal_act_as, gcal_event_id, held_at"

export function makeJointStore(db: Db, now: () => number = Date.now): JointStore {
  return {
    async byHash(hash) {
      const { data, error } = await db.from("marketing_joint_links").select(COLS).eq("token_hash", hash).maybeSingle()
      if (error) throw new Error(`joint link read: ${error.message}`)
      return (data as LinkRecord | null) ?? null
    },
    async createLink(r) {
      // a new link takes back the ones still open for the same lead (a booked call keeps its own link)
      const rev = await db.from("marketing_joint_links").update({ revoked_at: new Date(now()).toISOString() }).eq("lead_id", r.leadId).eq("team_id", r.teamId).eq("status", "open").is("revoked_at", null)
      if (rev.error) throw new Error(`joint link revoke: ${rev.error.message}`)
      const { error } = await db.from("marketing_joint_links").insert({ team_id: r.teamId, lead_id: r.leadId, seller_user_id: r.sellerUserId, token_hash: r.tokenHash, lang: r.lang, created_by: r.createdBy, expires_at: r.expiresAt })
      if (error) throw new Error(`joint link create: ${error.message}`)
    },
    async hold(id, from, range, client) {
      const patch: Record<string, unknown> = { status: from === "open" ? "booking" : "booked", starts_at: range.startsAt, ends_at: range.endsAt, lock_from: range.lockFrom, lock_to: range.lockTo, ...(from === "open" ? { held_at: new Date(now()).toISOString() } : {}) }
      if (client) Object.assign(patch, { client_name: client.name, client_email: client.email, client_zone: client.zone })
      const { data, error } = await db.from("marketing_joint_links").update(patch).eq("id", id).eq("status", from).is("revoked_at", null).select("id")
      if (error) return isOverlapViolation(error) ? ("taken" as HoldResult) : (() => { throw new Error(`joint hold: ${error.message}`) })()
      return Array.isArray(data) && data.length === 1 ? "ok" : "changed"
    },
    async releaseHold(id) {
      const { error } = await db.from("marketing_joint_links").update({ status: "open", starts_at: null, ends_at: null, lock_from: null, lock_to: null, client_name: null, client_email: null, client_zone: null, zoom_meeting_id: null, zoom_join_url: null, gcal_act_as: null, gcal_event_id: null }).eq("id", id).eq("status", "booking")
      if (error) throw new Error(`joint release: ${error.message}`)
    },
    async restoreHold(id, range: HoldRange) {
      const { error } = await db.from("marketing_joint_links").update({ starts_at: range.startsAt, ends_at: range.endsAt, lock_from: range.lockFrom, lock_to: range.lockTo }).eq("id", id).eq("status", "booked")
      if (error) throw new Error(`joint restore: ${error.message}`)
    },
    async finishBooking(id, v) {
      const { data, error } = await db.from("marketing_joint_links").update({ status: "booked", zoom_meeting_id: v.zoomMeetingId, zoom_join_url: v.zoomJoinUrl, gcal_act_as: v.gcalActAs, gcal_event_id: v.gcalEventId, booked_at: new Date(now()).toISOString() }).eq("id", id).eq("status", "booking").select("id")
      return !error && Array.isArray(data) && data.length === 1
    },
    async cancel(id) {
      const { data, error } = await db.from("marketing_joint_links").update({ status: "cancelled", cancelled_at: new Date(now()).toISOString(), lock_from: null, lock_to: null }).eq("id", id).eq("status", "booked").select("id")
      return !error && Array.isArray(data) && data.length === 1
    },
    async activeFor(teamId, leadId) {
      const { data, error } = await db.from("marketing_joint_links").select(COLS).eq("team_id", teamId).eq("lead_id", leadId).in("status", ["booking", "booked"]).is("revoked_at", null).gt("ends_at", new Date(now()).toISOString()).order("created_at", { ascending: false }).limit(1)
      if (error) throw new Error(`joint active read: ${error.message}`)
      return ((data ?? [])[0] as LinkRecord | undefined) ?? null
    },
    async releaseStale(cutoffIso) {
      const { error } = await db.from("marketing_joint_links").update({ status: "open", starts_at: null, ends_at: null, lock_from: null, lock_to: null, client_name: null, client_email: null, client_zone: null, held_at: null }).eq("status", "booking").lt("held_at", cutoffIso)
      if (error) throw new Error(`joint stale release: ${error.message}`)
    },
    async otherHolds(excludeId) {
      let q = db.from("marketing_joint_links").select("id, starts_at, ends_at").in("status", ["booking", "booked"]).gte("ends_at", new Date(now() - 3_600_000).toISOString())
      if (excludeId) q = q.neq("id", excludeId)
      const { data, error } = await q
      if (error) throw new Error(`joint holds: ${error.message}`)
      return ((data ?? []) as Array<{ starts_at: string; ends_at: string }>).map(r => ({ start: Date.parse(r.starts_at), end: Date.parse(r.ends_at) })).filter((b): b is Interval => !Number.isNaN(b.start) && !Number.isNaN(b.end))
    },
  }
}
