/**
 * TD Marketing — who reads which clock (pure; dev job 9aec66fa, Addendum K, build steps B1 and B2). The settings hold each person's zone, the seller's hours and links; this file turns them into
 * what a screen needs: the zone a viewer reads times in, who takes calls, and WHICH CLOCKS A LEAD SHOWS TO WHOM. The rule that matters (Antonio, 30 Oct 2026: "the setter doesn't need to see my
 * time, she is Rocco's employee") lives in `leadClocks` and is decided on the server: the setter's page is built without the owner's zone, it is not hidden on the screen. No database here.
 */
import { DEFAULT_CALL_HOURS, type CalendlyLink, type CallHoursInput } from "@/lib/marketing/settings-schema"
import { ROME, clockText, isValidZone, utcOffsetText } from "@/lib/marketing/zones"
import { personName } from "@/lib/marketing/setter-note"

export interface OwnerClock { zone: string; label: string; /** the owner's work mailbox, so the seller's calendar can show his time as Busy */ email?: string }
export interface TimePrefs {
  ownerClock: OwnerClock
  memberZones: Record<string, string>
  callHours: Record<string, CallHoursInput>
  links: Record<string, CalendlyLink[]>
  personalCalendars: Record<string, string[]>
  busyEnabled: boolean
  writeThroughEnabled: boolean
}

/** What a stored settings object holds, with a safe value for anything missing. */
export function timePrefsFrom(s: {
  owner_clock?: OwnerClock; member_time_zones?: Record<string, string>; member_call_hours?: Record<string, CallHoursInput>; member_calendly_links?: Record<string, CalendlyLink[]>
  member_personal_calendars?: Record<string, string[]>; calendar_busy_enabled?: boolean; calendar_write_through_enabled?: boolean
}): TimePrefs {
  return {
    ownerClock: s.owner_clock && isValidZone(s.owner_clock.zone) ? s.owner_clock : { zone: ROME, label: "Owner" },
    memberZones: s.member_time_zones ?? {}, callHours: s.member_call_hours ?? {}, links: s.member_calendly_links ?? {}, personalCalendars: s.member_personal_calendars ?? {},
    busyEnabled: s.calendar_busy_enabled === true, writeThroughEnabled: s.calendar_write_through_enabled === true,
  }
}

export interface CallHours { start: number; end: number; slot: number; gap: number; notice: number; ahead: number; days: number[] }

/** A seller's hours with the built-in value for every field he has not set. */
export function resolveCallHours(h?: CallHoursInput | null): CallHours {
  const d = DEFAULT_CALL_HOURS
  return { start: h?.start ?? d.start, end: h?.end ?? d.end, slot: h?.slot ?? d.slot, gap: h?.gap ?? d.gap, notice: h?.notice ?? d.notice, ahead: h?.ahead ?? d.ahead, days: h?.days && h.days.length ? [...h.days] : [...d.days] }
}

/** A person's own zone; Rome (what every screen read before zones existed) when it is not set. */
export function memberZone(p: Pick<TimePrefs, "memberZones">, userId: string | null | undefined): string {
  const z = userId ? p.memberZones[userId] : undefined
  return isValidZone(z) ? z : ROME
}

/**
 * The zone a screen reads times in. Antonio on his own login (the owner frame) reads his owner clock; everybody else reads their own zone; "View as" reads the zone of the person he is looking in as
 * (`viewAsMemberId`, a member who holds the chosen role) so the preview shows what that person sees, and Rome when nobody holds that role.
 */
export function viewerZone(p: TimePrefs, v: { userId: string; ownerLogin: boolean; viewAsMemberId?: string | null }): string {
  if (v.ownerLogin) return p.ownerClock.zone
  return memberZone(p, v.viewAsMemberId ?? v.userId)
}

/**
 * "View as": whose page the preview is. A member who holds the previewed role comes first. When nobody holds it (the roles are not stored on the members today), a role that hosts calls
 * (the team owner and the seller have `calls.host`) is previewed as the seller himself, the first member who takes calls, so the preview reads his zone and his Google time exactly as his own
 * page does (Antonio, 31 Oct 2026: "the screenshot is from Rocco's page and I don't see them"). Any other role (the setter, the analyst) stays nobody: it shows no Google, as before.
 */
export function viewAsMember(
  v: { previewing: boolean; bundle: string | null; hostsCalls: boolean },
  rows: ReadonlyArray<{ user_id: string; status: string; bundle: string | null }>,
  takerIds: readonly string[],
): string | null {
  if (!v.previewing) return null
  const holder = v.bundle ? rows.find(m => m.status === "active" && m.bundle === v.bundle)?.user_id ?? null : null
  if (holder) return holder
  return v.hostsCalls ? takerIds[0] ?? null : null
}

export interface Taker { userId: string; label: string; /** the person's login (a work mailbox when his calendars are used) */ email: string | null }

/** The members who take calls with leads: the ones that have working hours in the settings, active, in the order given. */
export function callTakers(p: Pick<TimePrefs, "callHours">, members: ReadonlyArray<{ userId: string; email: string | null; status?: string }>): Taker[] {
  return members.filter(m => m.status !== "removed" && m.status !== "paused" && Object.prototype.hasOwnProperty.call(p.callHours, m.userId)).map(m => ({ userId: m.userId, label: personName(m.email), email: m.email }))
}

/** The seller of a lead: the one who picked it, when he takes calls; otherwise the first member who takes calls; nobody when nobody does. */
export function sellerForLead(takers: readonly Taker[], claimedBy: string | null): Taker | null {
  return takers.find(t => t.userId === claimedBy) ?? takers[0] ?? null
}

export type ClockKey = "client" | "seller" | "owner" | "you"
export interface Clock { key: ClockKey; label: string; zone: string | null }

/**
 * The clocks on a lead. Everybody sees the client's and the seller's. The owner's clock goes to the seller and the owner themselves; a setter sees her OWN instead and never the owner's (the setter works
 * for the seller). `clientZone` null = the lead's zone is not known yet: the clock is shown empty and asks for a zone.
 */
export function leadClocks(i: { leadName: string; clientZone: string | null; seller: { label: string; zone: string } | null; owner: OwnerClock; youZone: string; hideOwner: boolean }): Clock[] {
  const out: Clock[] = [{ key: "client", label: i.leadName, zone: i.clientZone }]
  if (i.seller) out.push({ key: "seller", label: i.seller.label, zone: i.seller.zone })
  out.push(i.hideOwner ? { key: "you", label: "You", zone: i.youZone } : { key: "owner", label: i.owner.label, zone: i.owner.zone })
  return out
}

/** Whose times a box that takes a day and time shows next to the typed one: the viewer's own zone, the lead's, the seller's and (never for a setter) the owner's. */
export interface ZoneInfo {
  viewer: string
  client: string | null
  clientName: string
  seller: { label: string; zone: string } | null
  owner: { label: string; zone: string } | null
}

/** The viewer's information for a lead: the owner's zone is only included for a person who may see it. */
export function zoneInfoFor(i: { viewerZone: string; clientZone: string | null; clientName: string; seller: { label: string; zone: string } | null; owner: OwnerClock; hideOwner: boolean }): ZoneInfo {
  return { viewer: i.viewerZone, client: i.clientZone, clientName: i.clientName, seller: i.seller, owner: i.hideOwner ? null : i.owner }
}

export interface TimeAt { key: "client" | "seller" | "owner"; label: string; zone: string; time: string; offset: string }

/** What time it is for everybody in `info` at one instant: the lead, the seller and (when allowed) the owner; a person whose zone is not known is left out. */
export function timesAt(at: Date | string | number, info: ZoneInfo): TimeAt[] {
  const out: TimeAt[] = []
  const add = (key: TimeAt["key"], label: string, zone: string | null) => { if (zone) out.push({ key, label, zone, time: clockText(at, zone), offset: utcOffsetText(at, zone) }) }
  add("client", info.clientName, info.client)
  if (info.seller) add("seller", info.seller.label, info.seller.zone)
  if (info.owner) add("owner", info.owner.label, info.owner.zone)
  return out
}

/** The banner on the seller's page: his time and the owner's. Only a person who takes calls and may see the owner's clock gets one. */
export function bannerClocks(i: { isTaker: boolean; hideOwner: boolean; youZone: string; owner: OwnerClock }): Clock[] {
  if (!i.isTaker || i.hideOwner) return []
  return [{ key: "you", label: "You", zone: i.youZone }, { key: "owner", label: i.owner.label, zone: i.owner.zone }]
}
