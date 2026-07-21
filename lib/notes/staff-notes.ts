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

export type NoteVisibility = "private" | "shared" | "team"

export interface StaffNoteInput {
  body: string
  color?: string
  account_id?: string | null
  contact_id?: string | null
  origin_url?: string | null
}

/** The columns every note reader returns (never selects nothing-sensitive extra). */
export const NOTE_COLUMNS =
  "id, body, color, author_user_id, author_name, visibility, shared_with_user_id, shared_with_name, account_id, contact_id, origin_url, snoozed_until, archived_at, created_at, updated_at"

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

/** Notes visible to U that are live (not archived) and not currently snoozed — the floating feed. */
export async function listActiveNotesForUser(userId: string, nowIso: string) {
  return supabaseAdmin
    .from("staff_notes")
    .select(NOTE_COLUMNS)
    .is("archived_at", null)
    .or(visibleToOrClause(userId))
    .or(notSnoozedOrClause(nowIso))
    .order("created_at", { ascending: false })
    .limit(200)
}

/** Notes visible to U that are attached to a given account (the on-company-page widget). */
export async function listNotesForAccount(userId: string, accountId: string) {
  return supabaseAdmin
    .from("staff_notes")
    .select(NOTE_COLUMNS)
    .is("archived_at", null)
    .eq("account_id", accountId)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(100)
}

/** Notes visible to U attached to a given contact. */
export async function listNotesForContact(userId: string, contactId: string) {
  return supabaseAdmin
    .from("staff_notes")
    .select(NOTE_COLUMNS)
    .is("archived_at", null)
    .eq("contact_id", contactId)
    .or(visibleToOrClause(userId))
    .order("created_at", { ascending: false })
    .limit(100)
}
