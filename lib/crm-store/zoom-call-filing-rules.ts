/**
 * Filing Zoom call folders (dev job 1f4645b6, 2026-11-11). PURE rules: no database, no clock of its own. The runner is `zoom-call-filing.ts`.
 *
 * What the job does (Antonio, 11 Nov 2026): a call recorded on his Mac lands as a folder named by Zoom ("2026-11-10 09.00.57 Luca Comaggi and Antonio Durante")
 * at the top of Business › Zoom Calls. Every call — booked on Calendly OR started straight from Zoom — must end in TD Zoom Calls › year › month. A call that
 * falls inside a booking made with the marketing booking link goes to TD Marketing Calls instead (the same rule the Zoom cloud-recording job already has).
 * Where a call goes never depends on a booking being found; the booking only decides "marketing or not" and says, in the activity log, where the call came from.
 *
 * Why it waits: after a call Zoom keeps writing (it turns the recording into video / audio) and the Mac uploads those files. A folder is only filed once nothing in
 * it has changed for QUIET_MINUTES and no upload for it is still open.
 */

export const OFFICE_ZONE = "America/New_York"
/** Nothing changed in the call folder for this long (and no upload open) = Zoom and the Mac are done with it. */
export const QUIET_MINUTES = 10
/** At most this many calls are filed in one run; the rest wait for the next run (10 minutes later). */
export const MAX_PER_RUN = 10
/** A call counts as "this booking" from this long before the booking starts … */
export const EARLY_MS = 15 * 60_000
/** … to this long after a Calendly booking starts (a 30-minute slot that runs long, or a recording started late) … */
export const CALENDLY_LATE_MS = 90 * 60_000
/** … or this long after a marketing booking ends. */
export const MARKETING_LATE_MS = 60 * 60_000
/** A marketing booking with no end time is treated as this long. */
export const MARKETING_DEFAULT_MS = 30 * 60_000

export type Origin = "calendly" | "marketing" | "zoom_direct"
export type Destination = "td_zoom" | "td_marketing"

export interface Booking { kind: "calendly" | "marketing"; start: Date; end: Date | null; who: string | null }

export interface CandidateFolder {
  id: string
  name: string
  /** When the CRM first saw the folder (the Mac made it as the recording started). */
  createdAt: Date
  /** The latest change anywhere inside it: a file added or changed, a new version, a sub-folder. */
  lastActivity: Date
  /** An upload for this folder is still open (the Mac is still sending a file). */
  uploadOpen: boolean
}

export type Decision =
  | { action: "skip"; reason: "not_a_call_folder" }
  | { action: "wait"; reason: "upload_running" | "still_changing" }
  | { action: "file"; destination: Destination; origin: Origin; booking: Booking | null; matchedOn: "name_time" | "arrival_time" | null }

/** Zoom's folder name starts with the call's start in the Mac's local time: YYYY-MM-DD HH.MM.SS (a regex literal on purpose: a RegExp built from a template string was folded wrongly by the production build once — R115). */
const CALL_NAME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})(?=\s|$)/

export const isCallFolderName = (name: string): boolean => CALL_NAME.test(name)

/** Offset of `zone` from UTC at this instant, in ms (positive = ahead of UTC). */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const seconds = Math.floor(utcMs / 1000) * 1000
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(seconds))
  const p: Record<string, number> = {}
  for (const part of parts) if (part.type !== "literal") p[part.type] = Number(part.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - seconds
}

/** A wall-clock time in `zone` → the real instant. Two passes so a time near a clock change still lands right. null = not a real date. */
export function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string = OFFICE_ZONE): Date | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(guess)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h) return null   // 2026-13-45 and the like
  let t = guess - zoneOffsetMs(guess, zone)
  t = guess - zoneOffsetMs(t, zone)
  return new Date(t)
}

/** The call's start read from the folder name (Zoom writes it in the Mac's local time — New York for Antonio's Mac, proved on 33 stored bookings). null = not a call folder. */
export function callStartFromName(name: string, zone: string = OFFICE_ZONE): Date | null {
  const m = CALL_NAME.exec(name)
  if (!m) return null
  return wallToInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), zone)
}

function windowOf(b: Booking): { from: number; to: number } {
  const from = b.start.getTime() - EARLY_MS
  if (b.kind === "calendly") return { from, to: b.start.getTime() + CALENDLY_LATE_MS }
  const end = b.end ? b.end.getTime() : b.start.getTime() + MARKETING_DEFAULT_MS
  return { from, to: end + MARKETING_LATE_MS }
}

/**
 * The booking this call belongs to, or null. The call's time is read two ways — the start in the folder name, and the moment the Mac made the folder —
 * and either one inside a booking's window counts (a Mac in another time zone still matches by its upload time). The booking whose start is nearest wins;
 * on a tie the marketing booking wins (it is the narrower, deliberate kind).
 */
export function findBooking(c: Pick<CandidateFolder, "name" | "createdAt">, bookings: readonly Booking[]): { booking: Booking; matchedOn: "name_time" | "arrival_time" } | null {
  const nameTime = callStartFromName(c.name)
  const probes: Array<{ at: Date; on: "name_time" | "arrival_time" }> = []
  if (nameTime) probes.push({ at: nameTime, on: "name_time" })
  probes.push({ at: c.createdAt, on: "arrival_time" })
  let best: { booking: Booking; matchedOn: "name_time" | "arrival_time"; distance: number } | null = null
  for (const b of bookings) {
    const w = windowOf(b)
    for (const p of probes) {
      const t = p.at.getTime()
      if (t < w.from || t > w.to) continue
      const distance = Math.abs(t - b.start.getTime())
      const better = !best || distance < best.distance || (distance === best.distance && b.kind === "marketing" && best.booking.kind !== "marketing")   // the name time is probed first, so it wins a tie on the same booking
      if (better) best = { booking: b, matchedOn: p.on, distance }
    }
  }
  return best ? { booking: best.booking, matchedOn: best.matchedOn } : null
}

/** Has nothing changed for long enough? A clock that is behind the folder's last change (negative age) is NOT quiet. */
export function isQuiet(c: Pick<CandidateFolder, "lastActivity">, now: Date, quietMinutes: number = QUIET_MINUTES): boolean {
  return now.getTime() - c.lastActivity.getTime() >= quietMinutes * 60_000
}

/** What to do with one folder at the top of Zoom Calls. */
export function decide(c: CandidateFolder, now: Date, bookings: readonly Booking[], quietMinutes: number = QUIET_MINUTES): Decision {
  if (!isCallFolderName(c.name) || !callStartFromName(c.name)) return { action: "skip", reason: "not_a_call_folder" }
  if (c.uploadOpen) return { action: "wait", reason: "upload_running" }
  if (!isQuiet(c, now, quietMinutes)) return { action: "wait", reason: "still_changing" }
  const hit = findBooking(c, bookings)
  if (hit?.booking.kind === "marketing") return { action: "file", destination: "td_marketing", origin: "marketing", booking: hit.booking, matchedOn: hit.matchedOn }
  if (hit) return { action: "file", destination: "td_zoom", origin: "calendly", booking: hit.booking, matchedOn: hit.matchedOn }
  return { action: "file", destination: "td_zoom", origin: "zoom_direct", booking: null, matchedOn: null }
}

const utcLabel = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`

/** The sentence written on the folder's activity log: where the call came from. */
export function originText(origin: Origin, booking: Booking | null): string {
  if (origin === "zoom_direct" || !booking) return "Started in Zoom (no booking found for this time)"
  const who = booking.who ? ` — ${booking.who}` : ""
  return origin === "marketing" ? `Marketing booking ${utcLabel(booking.start)}${who}` : `Calendly booking ${utcLabel(booking.start)}${who}`
}

/** Oldest-finished first; at most MAX_PER_RUN folders get filed per run (the rest are counted as `deferred`). */
export function orderForRun<T extends { lastActivity: Date }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime())
}
