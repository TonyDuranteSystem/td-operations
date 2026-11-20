/**
 * The switch for the per-member "portal access" tick (dev job beb43385, delivery B).
 *
 * Three states, set by Claude on Antonio's word (no screen, no button), the same pattern as the offer builder
 * (lib/offers/rollout.ts):
 *
 *   off  — the default. A missing row, a failed read or anything unknown means off (fails CLOSED). The wizards, the
 *          saving code and the welcome-package login loop behave exactly as they did before the tick existed.
 *   test — only for records marked as test (the company, the lead or the contact has is_test = true).
 *   on   — everyone.
 *
 * Stored in app_settings under `member_portal_access_enabled`: the boolean `true` = on, the text "test" = test.
 * Never write the production value without Antonio's word.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAppSetting } from '@/lib/settings'
import { featureVisible, parseRolloutValue, type RolloutMode } from '@/lib/offers/rollout'
import { pickSubjectRecord } from '@/lib/offers/rollout-server'

export const MEMBER_PORTAL_ACCESS_KEY = 'member_portal_access_enabled' as const

/** What the screen or the job knows about the record. The company wins over the lead, the lead over the contact. */
export interface MemberAccessSubject {
  accountId?: string | null
  leadId?: string | null
  contactId?: string | null
}

/** The stored mode. Any failure reads as off. */
export async function memberPortalAccessMode(): Promise<RolloutMode> {
  try {
    return parseRolloutValue(await getAppSetting<unknown>(MEMBER_PORTAL_ACCESS_KEY, null))
  } catch {
    return 'off'
  }
}

/**
 * Is the tick in force for this record? Only when the mode is "test" is the record looked up, and a record that cannot
 * be read never counts as a test record.
 */
export async function memberPortalAccessOn(subject: MemberAccessSubject): Promise<boolean> {
  const mode = await memberPortalAccessMode()
  if (mode === 'off') return false
  if (mode === 'on') return true
  try {
    const record = pickSubjectRecord(subject)
    if (!record) return featureVisible(mode, null)
    const { data, error } = await supabaseAdmin.from(record.table).select('is_test').eq('id', record.id).maybeSingle()
    if (error || !data) return featureVisible(mode, null)
    return featureVisible(mode, (data as { is_test?: boolean | null }).is_test === true)
  } catch {
    return false
  }
}
