/**
 * Server side of the "Columns" dropdown: one saved choice per login and per list.
 *
 * Kept with the login (not the computer) in the `prefs` jsonb of `portal_user_preferences` — the same small per-login table the
 * client app's saved bar already uses (see lib/portal-app/bar-pref.ts). No new table. Reading never throws: a failed read simply
 * means "nothing saved" and the person gets the standard set.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cleanColumns, columnPrefKey, parseColumnPref, type ListId } from '@/lib/crm-lists/columns'

// portal_user_preferences is not in the generated database types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prefsTable = () => (supabaseAdmin as any).from('portal_user_preferences')

export async function getColumnPref(authUserId: string, list: ListId): Promise<string[] | null> {
  try {
    const { data } = await prefsTable().select('prefs').eq('auth_user_id', authUserId).maybeSingle()
    return parseColumnPref(list, data?.prefs?.[columnPrefKey(list)])
  } catch {
    return null
  }
}

async function writePrefs(authUserId: string, change: (prefs: Record<string, unknown>) => Record<string, unknown>): Promise<boolean> {
  const { data: existing, error: readError } = await prefsTable().select('prefs').eq('auth_user_id', authUserId).maybeSingle()
  if (readError) return false
  const prefs = change({ ...((existing?.prefs as Record<string, unknown>) ?? {}) })
  const { error } = await prefsTable().upsert({ auth_user_id: authUserId, prefs, updated_at: new Date().toISOString() }, { onConflict: 'auth_user_id' })
  return !error
}

export async function setColumnPref(authUserId: string, list: ListId, cols: string[]): Promise<boolean> {
  const clean = cleanColumns(list, cols)
  return writePrefs(authUserId, (prefs) => ({ ...prefs, [columnPrefKey(list)]: { cols: clean, saved_at: new Date().toISOString() } }))
}

/** "Put the standard fields back": forget the choice (the person's other saved preferences stay). */
export async function clearColumnPref(authUserId: string, list: ListId): Promise<boolean> {
  return writePrefs(authUserId, (prefs) => {
    const next = { ...prefs }
    delete next[columnPrefKey(list)]
    return next
  })
}
