/**
 * Client iPhone app — the saved bottom bar (server; dev job 056a70d0, Step 2).
 *
 * Stored with the LOGIN (not the phone, not the company), so it follows the person to a new phone: one entry `app.bar` inside the
 * `prefs` jsonb of `portal_user_preferences`, the same table the portal already uses for the invoicing tour (its own writer accepts
 * only `tour.*` keys on purpose and is untouched). No database file: the table and its one row per login already exist.
 *
 * Reading never throws: a failed read means "nothing saved" and the person simply gets the standard bar. The value is re-validated on
 * every read (it may be old); what the person is SHOWN is always filtered by what they can open now (see bar.ts `effectiveBar`).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BAR_SIZE } from "@/lib/portal-app/bar"

export const BAR_PREF_KEY = "app.bar"

// portal_user_preferences is not in the generated database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prefsTable = () => (supabaseAdmin as any).from("portal_user_preferences")

/** Pure: the saved list from a stored value, or null when it is missing or not a list of text. */
export function parseBarPref(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null
  const keys = (raw as { keys?: unknown }).keys
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > APP_BAR_SIZE) return null
  if (!keys.every(k => typeof k === "string" && k.length > 0 && k.length <= 60)) return null
  return keys as string[]
}

export async function getBarPref(authUserId: string): Promise<string[] | null> {
  try {
    const { data } = await prefsTable().select("prefs").eq("auth_user_id", authUserId).maybeSingle()
    return parseBarPref(data?.prefs?.[BAR_PREF_KEY])
  } catch {
    return null
  }
}

async function writePrefs(authUserId: string, change: (prefs: Record<string, unknown>) => Record<string, unknown>): Promise<boolean> {
  const { data: existing, error: readError } = await prefsTable().select("prefs").eq("auth_user_id", authUserId).maybeSingle()
  if (readError) return false
  const prefs = change({ ...((existing?.prefs as Record<string, unknown>) ?? {}) })
  const { error } = await prefsTable().upsert({ auth_user_id: authUserId, prefs, updated_at: new Date().toISOString() }, { onConflict: "auth_user_id" })
  return !error
}

export async function setBarPref(authUserId: string, keys: string[]): Promise<{ ok: true } | { ok: false }> {
  const ok = await writePrefs(authUserId, prefs => ({ ...prefs, [BAR_PREF_KEY]: { keys, saved_at: new Date().toISOString() } }))
  return ok ? { ok: true } : { ok: false }
}

/** "Put the standard tabs back": forget the choice (the other saved preferences stay). */
export async function clearBarPref(authUserId: string): Promise<{ ok: true } | { ok: false }> {
  const ok = await writePrefs(authUserId, prefs => {
    const next = { ...prefs }
    delete next[BAR_PREF_KEY]
    return next
  })
  return ok ? { ok: true } : { ok: false }
}
