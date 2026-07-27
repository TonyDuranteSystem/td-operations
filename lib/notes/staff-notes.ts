/**
 * Staff sticky notes — server helpers (service-role writes behind a staff route guard).
 *
 * THE ONE visibility rule (imported by every reader so they can never disagree):
 *   a note is visible to staff user U iff
 *     author_user_id = U  OR  visibility = 'team'  OR  (visibility = 'shared' AND shared_with_user_id = U)
 *
 * Private notes never leave the server for anyone but the author. There is no board / counts /
 * entity-summary reader to leak into — staff_notes is a dedicated table (see the migration header).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// staff_notes is not in the generated Database types yet (the types are regenerated from
// production after the prod DDL). Same escape hatch as lib/ui-events.ts / lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const notesTable = () => (supabaseAdmin as any).from("staff_notes")

/** Every value `staff_notes.visibility` may hold — registered with the code↔database
 *  contract gate 2026-07-27 so a value the database rejects can never be written silently. */
export const STAFF_NOTE_VISIBILITIES = ["private", "shared", "team"] as const

export type NoteVisibility = (typeof STAFF_NOTE_VISIBILITIES)[number]

export interface StaffNoteInput {
  body: string
  color?: string
  account_id?: string | null
  contact_id?: string | null
  origin_url?: string | null
}

/**
 * The columns every note reader returns. The nested account/contact selects resolve the client's
 * NAME at read time (via the foreign keys) so the card can show "Aumianna LLC" without storing a
 * copy that would go stale when a company is renamed.
 */
export const NOTE_COLUMNS =
  "id, body, color, author_user_id, author_name, visibility, shared_with_user_id, shared_with_name, account_id, contact_id, origin_url, snoozed_until, archived_at, created_at, updated_at, accounts(company_name), contacts(full_name), staff_note_state(user_id, archived_at, snoozed_until)"

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-PERSON STATE. A note is ONE thing; "I have dealt with it" is PER PERSON.
 *
 * Antonio, 2026-07-23: "when I create a note for Luca, I have to click Done to
 * make it disappear. When I click Done, it disappears also for Luca, so Luca and
 * I are two different things." He was right, and it was worse than reported —
 * `archived_at` AND `snoozed_until` were both single columns on the note, so
 * snoozing a shared note also pulled it off the other person's screen and put it
 * back at a time they never chose.
 *
 * Done/Snooze now live in `staff_note_state`, one row per person per note.
 * NO ROW = live for that person. The note's own columns are legacy: still read
 * as a fallback for anything created before the change, never written.
 */

/** One person's state for one note. */
export interface NoteStateRow {
  user_id: string
  archived_at: string | null
  snoozed_until: string | null
}

interface NoteWithState {
  author_user_id?: string | null
  archived_at?: string | null
  snoozed_until?: string | null
  staff_note_state?: NoteStateRow[] | null
}

/** This person's state for this note, or null if they have never acted on it. */
export function noteStateFor(note: NoteWithState, userId: string): NoteStateRow | null {
  const rows = note?.staff_note_state
  if (!Array.isArray(rows)) return null
  return rows.find((r) => r?.user_id === userId) ?? null
}

/**
 * Has THIS person marked it done?
 *
 * Falls back to the note's legacy shared column ONLY when nobody has per-person
 * state at all — i.e. a note written before this change and never touched since.
 * Once anyone acts, the per-person rows are the whole truth, or a note one person
 * cleared would read as done for everyone again (the original bug).
 */
export function isArchivedFor(note: NoteWithState, userId: string): boolean {
  const mine = noteStateFor(note, userId)
  if (mine) return mine.archived_at != null
  const anyState = Array.isArray(note?.staff_note_state) && note.staff_note_state.length > 0
  if (anyState) return false
  return note?.archived_at != null
}

/** Is it snoozed out of THIS person's sight right now? */
export function isSnoozedFor(note: NoteWithState, userId: string, now: Date): boolean {
  const mine = noteStateFor(note, userId)
  const until = mine
    ? mine.snoozed_until
    : (Array.isArray(note?.staff_note_state) && note.staff_note_state.length > 0)
      ? null
      : note?.snoozed_until
  if (!until) return false
  const t = new Date(until).getTime()
  return Number.isFinite(t) && t > now.getTime()
}

/** On the floating layer right now, for this person. */
export function isLiveFor(note: NoteWithState, userId: string, now: Date): boolean {
  return !isArchivedFor(note, userId) && !isSnoozedFor(note, userId, now)
}

/** What someone else has done with a shared note — the Notes tab status line. */
export type OtherState = 'done' | 'snoozed' | 'open'

export function otherPersonState(note: NoteWithState, otherUserId: string, now: Date): OtherState {
  if (isArchivedFor(note, otherUserId)) return 'done'
  if (isSnoozedFor(note, otherUserId, now)) return 'snoozed'
  return 'open'
}

/**
 * Everyone the note reaches, apart from the viewer — so the Notes tab can say
 * where the other person stands. A shared note names one person; a team note is
 * summarised as a count by the caller, because listing every name is noise.
 */
export function otherViewersOf(
  note: { author_user_id: string | null; visibility: NoteVisibility; shared_with_user_id: string | null },
  viewerId: string,
  allStaffIds: readonly string[],
): string[] {
  if (note.visibility === 'team') return allStaffIds.filter((id) => id && id !== viewerId)
  const ids = new Set<string>()
  if (note.author_user_id) ids.add(note.author_user_id)
  if (note.visibility === 'shared' && note.shared_with_user_id) ids.add(note.shared_with_user_id)
  ids.delete(viewerId)
  return Array.from(ids)
}

/**
 * Canonical "visible to U" predicate as a PostgREST .or() string. Pair with the live/snooze
 * filters at the call site. PostgREST needs the nested AND wrapped in and(...).
 */
export function visibleToOrClause(userId: string): string {
  return `author_user_id.eq.${userId},visibility.eq.team,and(visibility.eq.shared,shared_with_user_id.eq.${userId})`
}

/**
 * Pure predicate — same rule as visibleToOrClause, for unit tests and any in-memory filter.
 * Keeping the two in lockstep is the whole point (one rule, no drift).
 */
export function isNoteVisibleTo(
  note: { author_user_id: string | null; visibility: NoteVisibility; shared_with_user_id: string | null },
  userId: string,
): boolean {
  if (note.author_user_id === userId) return true
  if (note.visibility === "team") return true
  if (note.visibility === "shared" && note.shared_with_user_id === userId) return true
  return false
}

/** "Currently not snoozed" as a PostgREST .or() string (snoozed into the future = hidden). */
export function notSnoozedOrClause(nowIso: string): string {
  return `snoozed_until.is.null,snoozed_until.lte.${nowIso}`
}

/**
 * Validate an in-app origin path. Must be a same-origin absolute path and NOT a protocol-relative
 * or backslash-smuggled off-site URL. Fixes the `/\evil.com` bypass in the dev-tracker helper
 * (browsers normalise `\`→`/`, so `startsWith('/') && !startsWith('//')` alone lets it through).
 */
export function safeOriginPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const s = raw.trim()
  if (!s.startsWith("/")) return null // must be a relative in-app path
  if (s.startsWith("//") || s.startsWith("/\\")) return null // protocol-relative / backslash smuggle
  if (s.includes("\\")) return null // no backslashes at all — browsers fold them to '/'
  if (/[\x00-\x1f]/.test(s)) return null // no control chars
  if (s.length > 512) return null
  return s
}

/** Bounds mirror the DB CHECK so we return a friendly error before Postgres does. */
export const NOTE_BODY_MAX = 4000

export function validateNoteBody(raw: unknown): { body: string | null; error: string | null } {
  if (typeof raw !== "string") return { body: null, error: "A note needs some text." }
  const body = raw.trim()
  if (!body) return { body: null, error: "A note needs some text." }
  if (body.length > NOTE_BODY_MAX) {
    return { body: null, error: `That note is too long (max ${NOTE_BODY_MAX} characters). Trim it and try again.` }
  }
  return { body, error: null }
}

/** Snooze presets → a concrete future ISO instant. DST-safe: shifts the date then sets the hour,
 *  never "now + N ms" (which lands an hour off across a clock change). `now` is injected for tests. */
export function computeSnoozeUntil(
  preset: "10min" | "1hour" | "tomorrow" | "custom",
  now: Date,
  customIso?: string,
): { iso: string | null; error: string | null } {
  if (preset === "custom") {
    if (!customIso) return { iso: null, error: "Pick a date and time." }
    const d = new Date(customIso)
    if (isNaN(d.getTime())) return { iso: null, error: "That date didn't make sense." }
    if (d.getTime() <= now.getTime()) return { iso: null, error: "Pick a time in the future." }
    return { iso: d.toISOString(), error: null }
  }
  if (preset === "10min") return { iso: new Date(now.getTime() + 10 * 60_000).toISOString(), error: null }
  if (preset === "1hour") return { iso: new Date(now.getTime() + 60 * 60_000).toISOString(), error: null }
  // tomorrow 9am local — shift the calendar day, then set the hour (DST-safe)
  const t = new Date(now)
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  return { iso: t.toISOString(), error: null }
}

/**
 * Notes visible to U that are live FOR U — the floating feed.
 *
 * Done/snooze are per-person now, so the filter cannot be a column predicate:
 * it depends on a row in a sibling table that may not exist. We fetch what U can
 * SEE and apply `isLiveFor` in code.
 *
 * KNOWN BOUND, stated rather than hidden: the limit is applied by the database
 * BEFORE the per-person filter, so with more live notes than the limit some
 * could be trimmed. At the real volume (single digits, two staff) this cannot
 * bite; if notes ever run to hundreds, this wants a database function that
 * filters and limits in one pass.
 */
export async function listActiveNotesForUser(userId: string, nowIso: string) {
  const res = await notesTable()
    .select(NOTE_COLUMNS)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(500)
  if (res.error) return res
  const now = new Date(nowIso)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = (res.data ?? []).filter((n: any) => isLiveFor(n, userId, now)).slice(0, 200)
  return { ...res, data: live }
}

/**
 * EVERY note visible to U, whatever its state — the Notes page. Includes snoozed and archived,
 * so a snoozed note is never lost and a cleared one can be brought back. The page groups them
 * client-side by state (active / snoozed / done).
 */
export async function listAllNotesForUser(userId: string) {
  return notesTable()
    .select(NOTE_COLUMNS)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(500)
}

/** Notes visible to U and live FOR U, attached to a given account (the on-company-page widget). */
export async function listNotesForAccount(userId: string, accountId: string) {
  const res = await notesTable()
    .select(NOTE_COLUMNS)
    .eq("account_id", accountId)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(200)
  return filterLiveForUser(res, userId, 100)
}

/** Notes visible to U and live FOR U, attached to a given contact. */
export async function listNotesForContact(userId: string, contactId: string) {
  const res = await notesTable()
    .select(NOTE_COLUMNS)
    .eq("contact_id", contactId)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(200)
  return filterLiveForUser(res, userId, 100)
}

/** Shared tail for the per-record widgets: keep only what is live for this person. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filterLiveForUser(res: any, userId: string, cap: number) {
  if (res.error) return res
  const now = new Date()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = (res.data ?? []).filter((n: any) => isLiveFor(n, userId, now)).slice(0, cap)
  return { ...res, data: live }
}
