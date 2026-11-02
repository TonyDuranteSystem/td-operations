/**
 * TD Marketing — the booking link WITH the owner: making a link, showing its free times, booking, moving and cancelling (dev job 0b916784, 1 Nov 2026). This file holds the ORDER of every step and what is
 * undone when a step fails; everything it touches (the database, Google, Zoom, the lead's history, the email) arrives through `JointEnv`, so each rule is tested with fakes and nothing here reaches a
 * real service. The rules that matter:
 *   - the times offered are the seller's free times AND the owner's (joint-slots.ts); if Google cannot answer, NOTHING is offered (a time is never shown as free because Google was silent);
 *   - when the client confirms, the time is HELD first (the database refuses a second hold on the same time), then both calendars are asked AGAIN, and only then the Zoom meeting and the Google event are made;
 *   - every step after the hold has an undo: whatever failed, the time is released and nothing half-made stays on a calendar or in Zoom;
 *   - the call is also written into the lead's history as the usual "appointment" (so the Calendar, the seller's own free times and the history all see it); a staff move in the Calendar follows the same Google event;
 *   - every refusal the client sees is one generic message; the page never shows what made a time unavailable.
 */
import { hashInviteToken, newInviteToken, normalizeEmail, plausibleToken } from "@/lib/marketing/invite-rules"
import { checkShare, isWorkMailbox, shareOk, type GcalApi } from "@/lib/marketing/gcal"
import { jointSlots } from "@/lib/marketing/joint-slots"
import type { Interval } from "@/lib/marketing/free-slots"
import { memberZone, resolveCallHours, sellerForLead, type Taker, type TimePrefs } from "@/lib/marketing/time-prefs"
import type { OwnerCallHours } from "@/lib/marketing/settings-schema"
import type { ZoomApi } from "@/lib/zoom"
import { isValidZone } from "@/lib/marketing/zones"
import {
  JOINT_TTL_MS, GENERIC_LINK_ERROR, TIME_TAKEN_ERROR, buildJointMail, eventDescription, eventTitle, linkState, lockRange, pickJointLang,
  type JointLang, type JointMail, type JointMailKind, type LinkRow,
} from "@/lib/marketing/joint-rules"

export interface LinkRecord extends LinkRow {
  id: string; team_id: string; lead_id: string; seller_user_id: string; lang: JointLang
  ends_at: string | null
  client_name: string | null; client_email: string | null; client_zone: string | null
  zoom_meeting_id: string | null; zoom_join_url: string | null; gcal_act_as: string | null; gcal_event_id: string | null
  /** when the time was held for a booking still being finished (a hold older than STALE_HOLD_MS is given back) */
  held_at?: string | null
}
/** A booking being finished holds its time only this long: a booking cut off halfway (the server stopped, Google or Zoom hung) must not block the time for good. */
export const STALE_HOLD_MS = 5 * 60_000
export type HoldRange = { startsAt: string; endsAt: string; lockFrom: string; lockTo: string }
export type HoldResult = "ok" | "taken" | "changed"

/** The database side, as the booking needs it. The real one is joint-store.ts; tests use a small in-memory one. */
export interface JointStore {
  byHash(hash: string): Promise<LinkRecord | null>
  /** Takes back every link of the lead that is still open, then adds the new one. */
  createLink(row: { teamId: string; leadId: string; sellerUserId: string; tokenHash: string; lang: JointLang; createdBy: string | null; expiresAt: string }): Promise<void>
  /** Holds a time: `from` must be the row's current status. "taken" = another call holds an overlapping time; "changed" = the row is no longer in `from`. */
  hold(id: string, from: "open" | "booked", range: HoldRange, client?: { name: string; email: string; zone: string }): Promise<HoldResult>
  /** The time is not wanted any more (a step failed): back to open, with nothing left on the row. */
  releaseHold(id: string): Promise<void>
  /** A moved call whose later steps failed: back to the time it had. */
  restoreHold(id: string, range: HoldRange): Promise<void>
  finishBooking(id: string, v: { zoomMeetingId: string; zoomJoinUrl: string; gcalActAs: string; gcalEventId: string }): Promise<boolean>
  /** booked -> cancelled, once; false when it was not booked any more. */
  cancel(id: string): Promise<boolean>
  /** The times of every other link's call (booking or booked), as busy for both people. */
  otherHolds(excludeId: string | null): Promise<Interval[]>
  /** The lead's call that is being booked, or booked and not over yet, if any. */
  activeFor(teamId: string, leadId: string): Promise<LinkRecord | null>
  /** Gives back every time held by a booking started before `cutoffIso` and never finished (status booking -> open, with nothing left on the row). */
  releaseStale(cutoffIso: string): Promise<void>
}

export interface LeadFacts { id: string; full_name: string | null; email: string | null; phone: string | null; country: string | null; claimed_by: string | null }
export type CallOp = { kind: "set"; at: string; note: string } | { kind: "move"; at: string; from: string; note: string } | { kind: "cancel"; note: string }

export interface JointEnv {
  store: JointStore
  gcal: GcalApi
  zoom: ZoomApi
  zoomReady: () => boolean
  now: () => number
  baseUrl: string
  context(teamId: string): Promise<{ prefs: TimePrefs; takers: Taker[]; ownerHours: OwnerCallHours; sellerAppointments: (userId: string, excludeLeadId: string | null) => Promise<Interval[]> }>
  lead(teamId: string, leadId: string): Promise<LeadFacts | null>
  recordCall(teamId: string, leadId: string, op: CallOp): Promise<{ ok: true } | { ok: false; error: string }>
  recordSynced(leadId: string, kind: "calendar_synced" | "calendar_sync_failed", data: Record<string, unknown>): Promise<void>
  sendMail(to: string, mail: JointMail): Promise<void>
  /** a plain note for the seller ("the client cancelled") */
  tellSeller(teamId: string, sellerUserId: string, leadId: string, text: string): Promise<void>
}

export const manageUrl = (env: Pick<JointEnv, "baseUrl">, token: string) => `${env.baseUrl}/marketing/book/${token}`

// ── making a link ────────────────────────────────────────────────────────────────────────────

export type MakeLink = { ok: true; token: string; url: string; expiresAt: string; lang: JointLang; sellerLabel: string } | { ok: false; error: string; status: 400 | 404 | 409 | 503 }

export async function createJointLink(env: JointEnv, i: { teamId: string; leadId: string; createdBy: string | null }): Promise<MakeLink> {
  const lead = await env.lead(i.teamId, i.leadId)
  if (!lead) return { ok: false, error: "Lead not found.", status: 404 }
  const ctx = await env.context(i.teamId)
  const seller = sellerForLead(ctx.takers, lead.claimed_by)
  if (!seller || !isWorkMailbox(seller.email)) return { ok: false, error: "Nobody with a company mailbox is set up to take calls, so there is nothing to offer.", status: 409 }
  if (!ctx.prefs.busyEnabled) return { ok: false, error: "The calendar times are switched off. Ask Antonio to switch them on first.", status: 503 }
  if (!isWorkMailbox(ctx.prefs.ownerClock.email)) return { ok: false, error: "Antonio's calendar is not connected yet. Ask him to set it up.", status: 503 }
  if (!env.zoomReady()) return { ok: false, error: "Zoom is not connected yet. Ask Antonio to finish the Zoom step.", status: 503 }
  if (await env.store.activeFor(i.teamId, i.leadId)) return { ok: false, error: "This lead already has a call booked with Antonio. Move or cancel that call first, then make a new link.", status: 409 }
  const token = newInviteToken()
  const expiresAt = new Date(env.now() + JOINT_TTL_MS).toISOString()
  const lang = pickJointLang(lead)
  await env.store.createLink({ teamId: i.teamId, leadId: i.leadId, sellerUserId: seller.userId, tokenHash: hashInviteToken(token), lang, createdBy: i.createdBy, expiresAt })
  return { ok: true, token, url: manageUrl(env, token), expiresAt, lang, sellerLabel: seller.label }
}

// ── the free times ───────────────────────────────────────────────────────────────────────────

interface Offer { starts: number[]; minutes: number; gap: number; sellerZone: string; seller: Taker; ownerEmail: string }

/** The times at which the seller and the owner are both free right now, or null when Google cannot be asked (nothing is then offered). `ownSlot` is the call being moved: it does not block itself. */
async function computeOffer(env: JointEnv, row: LinkRecord, ownSlot: { startMs: number; endMs: number } | null, excludeHoldId: string | null): Promise<Offer | null> {
  try {
    const ctx = await env.context(row.team_id)
    const seller = ctx.takers.find(t => t.userId === row.seller_user_id)
    const ownerEmail = ctx.prefs.ownerClock.email
    if (!seller || !isWorkMailbox(seller.email) || !isWorkMailbox(ownerEmail) || !ctx.prefs.busyEnabled) return null
    const personal = ctx.prefs.personalCalendars[seller.userId] ?? []
    if (!shareOk(await checkShare(env.gcal, seller.email, personal))) return null
    const hours = resolveCallHours(ctx.prefs.callHours[seller.userId])
    const nowMs = env.now()
    const toIso = new Date(nowMs + (hours.ahead + 2) * 86_400_000).toISOString(), fromIso = new Date(nowMs).toISOString()
    const ids = ["primary", ...personal]
    const [sFb, oFb] = await Promise.all([env.gcal.freeBusy(seller.email, ids, fromIso, toIso), env.gcal.freeBusy(ownerEmail, ["primary"], fromIso, toIso)])
    if (ids.some(id => !sFb[id] || sFb[id].error) || !oFb.primary || oFb.primary.error) return null
    const sellerBusy: Interval[] = ids.flatMap(id => sFb[id].busy.map(b => ({ start: b.start, end: b.end })))
    const ownerBusy: Interval[] = oFb.primary.busy.map(b => ({ start: b.start, end: b.end }))
    // the seller's other calls booked in Marketing hold their hour too
    for (const a of await ctx.sellerAppointments(seller.userId, ownSlot ? row.lead_id : null)) sellerBusy.push(a)
    // a call being moved does not block itself: its own Google event shows as busy for both people
    if (ownSlot) for (const list of [sellerBusy, ownerBusy]) { const k = list.findIndex(b => b.start === ownSlot.startMs && b.end === ownSlot.endMs); if (k >= 0) list.splice(k, 1) }
    for (const h of await env.store.otherHolds(excludeHoldId ?? row.id)) { sellerBusy.push(h); ownerBusy.push(h) }
    const sellerZone = memberZone(ctx.prefs, seller.userId)
    const starts = jointSlots({ sellerZone, sellerHours: hours, sellerBusy, owner: { zone: ctx.prefs.ownerClock.zone, hours: ctx.ownerHours, busy: ownerBusy }, nowMs })
    return { starts, minutes: hours.slot, gap: hours.gap, sellerZone, seller, ownerEmail }
  } catch { return null }
}

// ── what the page shows ──────────────────────────────────────────────────────────────────────

export type PublicView =
  | { state: "open"; lang: JointLang; firstName: string; sellerLabel: string; minutes: number; starts: string[] }
  | { state: "unavailable"; lang: JointLang }
  | { state: "booked"; lang: JointLang; startIso: string; endIso: string; joinUrl: string | null; minutes: number; /** only when the page asks to move the call: the other times that are free */ starts?: string[] }
  | { state: "cancelled"; lang: JointLang }
  | { state: "unusable" }

const firstNameOf = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0]?.slice(0, 40) ?? ""

async function rowFor(env: JointEnv, token: unknown): Promise<LinkRecord | null> {
  if (!plausibleToken(token)) return null
  // a booking cut off halfway would hold its time for good: every request first gives back the holds that were never finished
  await env.store.releaseStale(new Date(env.now() - STALE_HOLD_MS).toISOString()).catch(() => undefined)
  return env.store.byHash(hashInviteToken(token))
}

export async function viewJointLink(env: JointEnv, token: unknown, opts: { moveTimes?: boolean } = {}): Promise<PublicView> {
  const row = await rowFor(env, token)
  const state = linkState(row, env.now())
  if (!row || state === "unusable") return { state: "unusable" }
  if (state === "cancelled") return { state: "cancelled", lang: row.lang }
  if (state === "booked") {
    const start = Date.parse(row.starts_at as string), end = Date.parse(row.ends_at as string)
    const base = { state: "booked" as const, lang: row.lang, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString(), joinUrl: row.zoom_join_url, minutes: Math.round((end - start) / 60_000) }
    if (!opts.moveTimes) return base
    const offer = await computeOffer(env, row, { startMs: start, endMs: end }, null)
    return { ...base, starts: (offer?.starts ?? []).filter(ms => ms !== start).map(ms => new Date(ms).toISOString()) }
  }
  const [lead, offer] = await Promise.all([env.lead(row.team_id, row.lead_id), computeOffer(env, row, null, null)])
  if (!lead || !offer) return { state: "unavailable", lang: row.lang }
  return { state: "open", lang: row.lang, firstName: firstNameOf(lead.full_name), sellerLabel: offer.seller.label, minutes: offer.minutes, starts: offer.starts.map(ms => new Date(ms).toISOString()) }
}

// ── booking ──────────────────────────────────────────────────────────────────────────────────

export type JointResult = { ok: true; startIso: string; endIso: string; joinUrl: string; mailed: boolean; warnings: string[] } | { ok: false; error: string; status: 400 | 404 | 409 | 502 | 503 }

const nope = (error: string, status: 400 | 404 | 409 | 502 | 503 = 409): JointResult => ({ ok: false, error, status })
const whenText = (ms: number, endMs: number, zone: string, lang: JointLang) => {
  const loc = lang === "it" ? "it-IT" : "en-GB"
  const day = new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "long", timeZone: zone }).format(ms)
  const hm = (t: number) => new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone }).format(t)
  return `${day}, ${hm(ms)} – ${hm(endMs)}`
}
const rangeOf = (startMs: number, minutes: number, gap: number): HoldRange => {
  const r = lockRange(startMs, minutes, gap)
  return { startsAt: new Date(r.startMs).toISOString(), endsAt: new Date(r.endMs).toISOString(), lockFrom: new Date(r.fromMs).toISOString(), lockTo: new Date(r.toMs).toISOString() }
}

async function tryMail(env: JointEnv, to: string | null, kind: JointMailKind, row: LinkRecord, token: string, startMs: number, endMs: number, zone: string, joinUrl: string | null): Promise<boolean> {
  if (!to) return false
  try {
    await env.sendMail(to, buildJointMail({ kind, lang: row.lang, name: row.client_name ?? "", whenText: whenText(startMs, endMs, zone, row.lang), zoneText: zone, joinUrl, manageUrl: token ? manageUrl(env, token) : "" }))
    return true
  } catch { return false }
}

export async function bookJoint(env: JointEnv, token: unknown, i: { startIso: unknown; name: unknown; email: unknown; zone: unknown }): Promise<JointResult> {
  const row = await rowFor(env, token)
  if (!row || linkState(row, env.now()) !== "open") return nope(GENERIC_LINK_ERROR, 404)
  const email = normalizeEmail(i.email)
  const name = typeof i.name === "string" ? i.name.trim().replace(/\s+/g, " ").slice(0, 100) : ""
  const startMs = typeof i.startIso === "string" ? Date.parse(i.startIso) : NaN
  if (!email || !name || Number.isNaN(startMs)) return nope("Check your name, your email and the time you chose.", 400)
  const zone = isValidZone(i.zone) ? i.zone : "Europe/Rome"
  const t = token as string

  const offer = await computeOffer(env, row, null, null)
  if (!offer) return nope("Times cannot be shown right now. Please try again in a few minutes.", 503)
  if (!offer.starts.includes(startMs)) return nope(TIME_TAKEN_ERROR)
  const range = rangeOf(startMs, offer.minutes, offer.gap)
  const endMs = Date.parse(range.endsAt)

  const held = await env.store.hold(row.id, "open", range, { name, email, zone })
  if (held === "taken") return nope(TIME_TAKEN_ERROR)
  if (held === "changed") return nope(GENERIC_LINK_ERROR, 404)

  const undo: Array<() => Promise<void>> = [async () => env.store.releaseHold(row.id)]
  const fail = async (error: string, status: 409 | 502 | 503): Promise<JointResult> => { for (const u of undo.reverse()) { try { await u() } catch { /* best effort: the next step of the undo still runs */ } } return nope(error, status) }
  try {
    const lead = await env.lead(row.team_id, row.lead_id)
    // the hold is ours: ask both calendars again, with our own hold left out
    const again = await computeOffer(env, { ...row, status: "booking" }, null, row.id)
    if (!again) return await fail("Times cannot be shown right now. Please try again in a few minutes.", 503)
    if (!again.starts.includes(startMs)) return await fail(TIME_TAKEN_ERROR, 409)

    const zoom = await env.zoom.createMeeting({ topic: `Call with Antonio Durante · ${firstNameOf(name) || "client"}`, startIso: range.startsAt, minutes: offer.minutes, timeZone: offer.sellerZone })
    undo.push(async () => env.zoom.deleteMeeting(zoom.id))
    const ev = await env.gcal.createEvent(offer.seller.email as string, "primary", {
      title: eventTitle(lead?.full_name ?? name), startIso: range.startsAt, endIso: range.endsAt, timeZone: offer.sellerZone, leadId: row.lead_id,
      attendees: [offer.ownerEmail, email], location: zoom.joinUrl, description: eventDescription({ joinUrl: zoom.joinUrl, manageUrl: manageUrl(env, t), sellerLabel: offer.seller.label, clientName: name }), sendUpdates: "all",
    })
    undo.push(async () => env.gcal.removeEvent(offer.seller.email as string, "primary", ev.id))
    const recorded = await env.recordCall(row.team_id, row.lead_id, { kind: "set", at: range.startsAt, note: "Booked by the client through the booking link with Antonio (Zoom)" })
    if (recorded.ok === false) return await fail("The booking could not be saved. Please try again.", 502)
    undo.push(async () => { await env.recordCall(row.team_id, row.lead_id, { kind: "cancel", note: "The booking could not be finished and was taken back" }) })
    const done = await env.store.finishBooking(row.id, { zoomMeetingId: zoom.id, zoomJoinUrl: zoom.joinUrl, gcalActAs: offer.seller.email as string, gcalEventId: ev.id })
    if (!done) return await fail("The booking could not be saved. Please try again.", 502)

    await env.recordSynced(row.lead_id, "calendar_synced", { event_id: ev.id, act_as: offer.seller.email, calendar_id: "primary", removed: false, joint: true })
    const mailed = await tryMail(env, email, "booked", { ...row, client_name: name }, t, startMs, endMs, zone, zoom.joinUrl)
    return { ok: true, startIso: range.startsAt, endIso: range.endsAt, joinUrl: zoom.joinUrl, mailed, warnings: mailed ? [] : ["The confirmation email could not be sent."] }
  } catch (e) {
    return await fail(e instanceof Error && /Zoom/.test(e.message) ? "The video call could not be created. Please try again in a few minutes." : "The booking could not be finished. Please try again.", 502)
  }
}

// ── moving ───────────────────────────────────────────────────────────────────────────────────

export async function moveJoint(env: JointEnv, token: unknown, i: { startIso: unknown }): Promise<JointResult> {
  const row = await rowFor(env, token)
  if (!row || linkState(row, env.now()) !== "booked" || !row.starts_at || !row.ends_at || !row.gcal_event_id || !row.gcal_act_as || !row.zoom_meeting_id || !row.zoom_join_url) return nope(GENERIC_LINK_ERROR, 404)
  const startMs = typeof i.startIso === "string" ? Date.parse(i.startIso) : NaN
  if (Number.isNaN(startMs)) return nope("Choose a time.", 400)
  // what the call has NOW, taken before anything changes (the undo and the history line below need the old time)
  const oldStartIso = row.starts_at, oldEndIso = row.ends_at, zoomId = row.zoom_meeting_id, eventId = row.gcal_event_id, actAs = row.gcal_act_as, joinUrl = row.zoom_join_url
  const oldStart = Date.parse(oldStartIso), oldEnd = Date.parse(oldEndIso)
  const own = { startMs: oldStart, endMs: oldEnd }
  const t = token as string
  const offer = await computeOffer(env, row, own, null)
  if (!offer) return nope("Times cannot be shown right now. Please try again in a few minutes.", 503)
  if (startMs === oldStart || !offer.starts.includes(startMs)) return nope(TIME_TAKEN_ERROR)
  const range = rangeOf(startMs, offer.minutes, offer.gap)
  const old = rangeOf(oldStart, Math.round((oldEnd - oldStart) / 60_000), offer.gap)
  const endMs = Date.parse(range.endsAt)
  const zone = isValidZone(row.client_zone) ? row.client_zone : "Europe/Rome"

  const held = await env.store.hold(row.id, "booked", range)
  if (held === "taken") return nope(TIME_TAKEN_ERROR)
  if (held === "changed") return nope(GENERIC_LINK_ERROR, 404)
  const undo: Array<() => Promise<void>> = [async () => env.store.restoreHold(row.id, old)]
  const fail = async (error: string): Promise<JointResult> => { for (const u of undo.reverse()) { try { await u() } catch { /* best effort */ } } return nope(error, 502) }
  try {
    const again = await computeOffer(env, row, own, row.id)
    if (!again) return await fail("Times cannot be shown right now. Please try again in a few minutes.")
    if (!again.starts.includes(startMs)) { for (const u of undo.reverse()) { try { await u() } catch { /* best effort */ } } return nope(TIME_TAKEN_ERROR) }
    await env.zoom.updateMeeting(zoomId, { startIso: range.startsAt, minutes: offer.minutes, timeZone: offer.sellerZone })
    undo.push(async () => env.zoom.updateMeeting(zoomId, { startIso: oldStartIso, minutes: Math.round((oldEnd - oldStart) / 60_000), timeZone: offer.sellerZone }))
    await env.gcal.moveEvent(actAs, "primary", eventId, { startIso: range.startsAt, endIso: range.endsAt, timeZone: offer.sellerZone, notify: true })
    undo.push(async () => { await env.gcal.moveEvent(actAs, "primary", eventId, { startIso: oldStartIso, endIso: oldEndIso, timeZone: offer.sellerZone, notify: true }) })
    const recorded = await env.recordCall(row.team_id, row.lead_id, { kind: "move", at: range.startsAt, from: oldStartIso, note: "Moved by the client through the booking link" })
    if (recorded.ok === false) return await fail("The change could not be saved. Please try again.")
    await env.tellSeller(row.team_id, row.seller_user_id, row.lead_id, "The client moved the call with Antonio.").catch(() => undefined)
    const mailed = await tryMail(env, row.client_email, "moved", row, t, startMs, endMs, zone, joinUrl)
    return { ok: true, startIso: range.startsAt, endIso: range.endsAt, joinUrl, mailed, warnings: [] }
  } catch { return await fail("The change could not be finished. Please try again.") }
}

/** Google answers 404/410 for an event somebody (staff) already removed: that is the result we wanted. */
const eventAlreadyGone = (e: unknown) => /Calendar API (404|410)/.test(String((e as Error)?.message ?? e))

// ── cancelling ───────────────────────────────────────────────────────────────────────────────

export type CancelResult = { ok: true; warnings: string[] } | { ok: false; error: string; status: 404 | 409 }

/** The client's cancel always succeeds for the client once the call is marked cancelled; what could not be taken down afterwards (Google, Zoom) is written on the lead for the seller, never shown to the client. */
export async function cancelJoint(env: JointEnv, token: unknown): Promise<CancelResult> {
  const row = await rowFor(env, token)
  if (!row || linkState(row, env.now()) !== "booked" || !row.starts_at || !row.ends_at) return { ok: false, error: GENERIC_LINK_ERROR, status: 404 }
  if (!(await env.store.cancel(row.id))) return { ok: false, error: GENERIC_LINK_ERROR, status: 409 }
  const warnings: string[] = []
  if (row.zoom_meeting_id) { try { await env.zoom.deleteMeeting(row.zoom_meeting_id) } catch { warnings.push("The Zoom meeting could not be deleted.") } }
  if (row.gcal_act_as && row.gcal_event_id) { try { await env.gcal.removeEvent(row.gcal_act_as, "primary", row.gcal_event_id) } catch (e) { if (!eventAlreadyGone(e)) warnings.push("The call could not be taken off the calendars.") } }
  const rec = await env.recordCall(row.team_id, row.lead_id, { kind: "cancel", note: "Cancelled by the client through the booking link" })
  if (rec.ok === false) warnings.push("The cancellation could not be written on the lead.")
  if (warnings.some(w => /calendars/.test(w))) await env.recordSynced(row.lead_id, "calendar_sync_failed", { message: "The call was cancelled by the client but is still on the calendars: remove it by hand." }).catch(() => undefined)
  else await env.recordSynced(row.lead_id, "calendar_synced", { event_id: row.gcal_event_id, act_as: row.gcal_act_as, calendar_id: "primary", removed: true, joint: true }).catch(() => undefined)
  const zone = isValidZone(row.client_zone) ? row.client_zone : "Europe/Rome"
  await tryMail(env, row.client_email, "cancelled", row, "", Date.parse(row.starts_at), Date.parse(row.ends_at), zone, null)
  await env.tellSeller(row.team_id, row.seller_user_id, row.lead_id, warnings.length ? `The client cancelled the call with Antonio, but: ${warnings.join(" ")}` : "The client cancelled the call with Antonio.").catch(() => undefined)
  return { ok: true, warnings }
}


// ── a staff change in the Calendar ───────────────────────────────────────────────────────────

export type StaffChange = { kind: "set"; at: string } | { kind: "cancel" }

/**
 * Staff moved or cancelled the lead's call in the Calendar (the lead's history and the Google event are handled by the usual path). When that call came from a booking link, the link, the Zoom meeting and the client
 * must follow: the link takes the new time (or is cancelled), Zoom is moved (or deleted), and the client gets the same "moved" / "cancelled" email as when the client does it. Returns a plain note ONLY when something could not be
 * done (written on the lead by the caller); nothing here ever fails the staff's own change.
 */
export async function followStaffChange(env: JointEnv, i: { teamId: string; leadId: string; change: StaffChange }): Promise<string | null> {
  const row = await env.store.activeFor(i.teamId, i.leadId)
  if (!row || row.status !== "booked" || !row.starts_at || !row.ends_at || !row.zoom_meeting_id) return null
  const startMs = Date.parse(row.starts_at), endMs = Date.parse(row.ends_at)
  const zone = isValidZone(row.client_zone) ? row.client_zone : "Europe/Rome"
  const notes: string[] = []
  if (i.change.kind === "cancel") {
    if (!(await env.store.cancel(row.id))) return null
    try { await env.zoom.deleteMeeting(row.zoom_meeting_id) } catch { notes.push("the Zoom meeting could not be deleted") }
    if (row.gcal_act_as && row.gcal_event_id) { try { await env.gcal.removeEvent(row.gcal_act_as, "primary", row.gcal_event_id) } catch (e) { if (!eventAlreadyGone(e)) notes.push("the call is still on the calendars") } }
    if (!(await tryMail(env, row.client_email, "cancelled", row, "", startMs, endMs, zone, null))) notes.push("the client was not emailed")
  } else {
    const newMs = Date.parse(i.change.at)
    if (Number.isNaN(newMs) || newMs === startMs) return null
    const ctx = await env.context(i.teamId)
    const seller = ctx.takers.find(t => t.userId === row.seller_user_id)
    const hours = resolveCallHours(ctx.prefs.callHours[row.seller_user_id])
    const minutes = Math.round((endMs - startMs) / 60_000)
    const range = rangeOf(newMs, minutes, hours.gap)
    const held = await env.store.hold(row.id, "booked", range)
    if (held !== "ok") return held === "taken" ? "the booking link kept its old time because another booked call overlaps the new one: tell the client" : "the booking link could not be updated: tell the client"
    const zoneSeller = seller ? memberZone(ctx.prefs, seller.userId) : zone
    try { await env.zoom.updateMeeting(row.zoom_meeting_id, { startIso: range.startsAt, minutes, timeZone: zoneSeller }) } catch { notes.push("the Zoom meeting still shows the old time") }
    if (row.gcal_act_as && row.gcal_event_id) { try { await env.gcal.moveEvent(row.gcal_act_as, "primary", row.gcal_event_id, { startIso: range.startsAt, endIso: range.endsAt, timeZone: zoneSeller, notify: false }) } catch { notes.push("the calendar event may still show the old time") } }
    const mailed = await tryMail(env, row.client_email, "moved", { ...row, starts_at: range.startsAt, ends_at: range.endsAt }, "", newMs, Date.parse(range.endsAt), zone, row.zoom_join_url)
    if (!mailed) notes.push("the client was not emailed")
  }
  return notes.length ? `The booking link followed the change, but ${notes.join("; ")}.` : null
}
