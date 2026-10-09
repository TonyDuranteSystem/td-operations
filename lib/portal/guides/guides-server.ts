/**
 * Server-side loading for the client guides (tour + checklist) and the per-login remembered state.
 * Pure rules live in ./guides.ts. Everything here fails SAFE: any error means "use the built-in default" /
 * "nothing remembered", never a broken page.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { listEntries } from '@/lib/catalog/framework'
import { t } from '@/lib/portal/i18n'
import {
  resolveTourDef, resolveChecklistDef, parseTourPref, TourPrefSchema, TOUR_PREF_KEY_RE,
  DEFAULT_INVOICING_TOUR, DEFAULT_INVOICING_CHECKLIST,
  type TourDef, type ChecklistDef, type TourPref,
} from './guides'

const hasKey = (key: string, lang: 'en' | 'it') => t(key, lang) !== key

export async function loadInvoicingGuides(): Promise<{ tour: TourDef; checklist: ChecklistDef }> {
  try {
    const rows = await listEntries('portal_guides', { status: 'active' })
    const tourRows = rows.filter(r => r.slug === 'tour-invoicing').map(r => ({ metadata: r.metadata, status: r.status }))
    const listRows = rows.filter(r => r.slug === 'checklist-invoicing').map(r => ({ metadata: r.metadata, status: r.status }))
    return { tour: resolveTourDef(tourRows, hasKey), checklist: resolveChecklistDef(listRows, hasKey) }
  } catch (err) {
    console.error('portal_guides could not be read; using the built-in tour and checklist:', err)
    return { tour: DEFAULT_INVOICING_TOUR, checklist: DEFAULT_INVOICING_CHECKLIST }
  }
}

// portal_user_preferences is new and not in the generated database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prefsTable = () => (supabaseAdmin as any).from('portal_user_preferences')

export async function getTourPref(authUserId: string, key: string): Promise<TourPref | null> {
  if (!TOUR_PREF_KEY_RE.test(key)) return null
  try {
    const { data } = await prefsTable().select('prefs').eq('auth_user_id', authUserId).maybeSingle()
    return parseTourPref(data?.prefs?.[key])
  } catch {
    return null
  }
}

export async function setTourPref(authUserId: string, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!TOUR_PREF_KEY_RE.test(key)) return { ok: false, error: 'Unknown preference.' }
  const parsed = TourPrefSchema.safeParse(value)
  if (!parsed.success) return { ok: false, error: 'Invalid value.' }
  const { data: existing } = await prefsTable().select('prefs').eq('auth_user_id', authUserId).maybeSingle()
  const prefs = { ...((existing?.prefs as Record<string, unknown>) ?? {}), [key]: parsed.data }
  const { error } = await prefsTable().upsert(
    { auth_user_id: authUserId, prefs, updated_at: new Date().toISOString() },
    { onConflict: 'auth_user_id' },
  )
  if (error) return { ok: false, error: 'Could not save. Please try again.' }
  return { ok: true }
}
