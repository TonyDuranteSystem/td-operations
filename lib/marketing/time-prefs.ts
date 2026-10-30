/**
 * TD Marketing — who reads which clock (pure; dev job 9aec66fa, Addendum K, build steps B1 and B2). The settings hold each person's zone, the seller's hours and links; this file turns them into
 * what a screen needs: the zone a viewer reads times in, who takes calls, and WHICH CLOCKS A LEAD SHOWS TO WHOM. The rule that matters (Antonio, 30 Oct 2026: "the setter doesn't need to see my
 * time, she is Rocco's employee") lives in `leadClocks` and is decided on the server: the setter's page is built without the owner's zone, it is not hidden on the screen. No database here.
 */
import { DEFAULT_CALL_HOURS, type CalendlyLink, type CallHoursInput } from "@/lib/marketing/settings-schema"
import { ROME, isValidZone } from "@/lib/marketing/zones"
import { personName } from "@/lib/marketing/setter-note"

export interface OwnerClock { zone: string; label: string }
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

export interface Taker { userId: string; label: string }

/** The members who take calls with leads: the ones that have working hours in the settings, active, in the order given. */
export function callTakers(p: Pick<TimePrefs, "callHours">, members: ReadonlyArray<{ userId: string; email: string | null; status?: string }>): Taker[] {
  return members.filter(m => m.status !== "removed" && m.status !== "paused" && Object.prototype.hasOwnProperty.call(p.callHours, m.userId)).map(m => ({ userId: m.userId, label: personName(m.email) }))
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

/** The banner on the seller's page: his time and the owner's. Only a person who takes calls and may see the owner's clock gets one. */
export function bannerClocks(i: { isTaker: boolean; hideOwner: boolean; youZone: string; owner: OwnerClock }): Clock[] {
  if (!i.isTaker || i.hideOwner) return []
  return [{ key: "you", label: "You", zone: i.youZone }, { key: "owner", label: i.owner.label, zone: i.owner.zone }]
}
