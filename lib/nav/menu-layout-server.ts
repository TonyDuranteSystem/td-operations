/**
 * Server side of the saved left-menu layout (dev job 45aa5872): read, save and clear one row per sign-in in
 * `staff_menu_layouts`. Reading never throws and has three answers (see getStaffMenuLayout), so the menu never breaks a page and
 * never saves over a layout it could not read. Saving reports a plain reason (R099) so the browser can tell the person.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseLayout, type MenuLayout, type ServerLayoutStatus } from '@/lib/nav/menu-layout'

// staff_menu_layouts is new and not in the generated database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = () => (supabaseAdmin as any).from('staff_menu_layouts')

export interface MenuLayoutRead { status: ServerLayoutStatus; layout?: MenuLayout }

/** The table not existing yet (the migration not run on an environment) is "nothing saved", not "unreadable". */
function tableMissing(error: { code?: string; message?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? '')
}

/**
 * Three answers, never a throw: `saved` (a valid layout), `none` (no row, or no table yet) and `unavailable` (the read itself failed).
 * The difference matters: with `unavailable` the real saved layout may exist, so the menu must not let anyone save a new one over it.
 */
export async function getStaffMenuLayout(userId: string): Promise<MenuLayoutRead> {
  try {
    const { data, error } = await table().select('layout').eq('auth_user_id', userId).maybeSingle()
    if (error) return { status: tableMissing(error) ? 'none' : 'unavailable' }
    if (!data) return { status: 'none' }
    const layout = parseLayout(data.layout)
    return layout ? { status: 'saved', layout } : { status: 'none' } // a damaged row counts as nothing saved
  } catch {
    return { status: 'unavailable' }
  }
}

export interface SaveResult { ok: boolean; error?: string }

export async function saveStaffMenuLayout(userId: string, layout: MenuLayout): Promise<SaveResult> {
  try {
    const { error } = await table().upsert(
      { auth_user_id: userId, layout, updated_at: new Date().toISOString() },
      { onConflict: 'auth_user_id' },
    )
    if (error) return { ok: false, error: 'Could not save your menu to your account. It is kept on this computer for now.' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not save your menu to your account. It is kept on this computer for now.' }
  }
}

export async function resetStaffMenuLayout(userId: string): Promise<SaveResult> {
  try {
    const { error } = await table().delete().eq('auth_user_id', userId)
    if (error) return { ok: false, error: 'Could not reset your saved menu. Try again in a moment.' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not reset your saved menu. Try again in a moment.' }
  }
}
