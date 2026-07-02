/**
 * TD Communication — system settings, stored in app_settings under the key
 * 'td_communication_settings' (one jsonb blob). Reuses lib/settings helpers —
 * no dedicated table. Server-only (getAppSetting/setAppSetting use supabaseAdmin).
 *
 * The pure merge logic (mergeCommSettings) is exported separately so it can be
 * unit-tested without the DB.
 */

import { getAppSetting, setAppSetting } from '@/lib/settings'
import type { TdCommSettings } from './types'

export const TD_COMM_SETTINGS_KEY = 'td_communication_settings' as const

/** Defaults: portal tab ON (preserves current teaser visibility), 7-day fallback SLA. */
export const DEFAULT_COMM_SETTINGS: TdCommSettings = {
  enabled: true,
  disclaimer_en: '',
  disclaimer_it: '',
  default_sla_days: 7,
  ai_enabled: true,
}

/** Pure: layer a (possibly partial / malformed) stored value over the defaults. */
export function mergeCommSettings(stored: Partial<TdCommSettings> | null | undefined): TdCommSettings {
  const s = stored ?? {}
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_COMM_SETTINGS.enabled,
    disclaimer_en: typeof s.disclaimer_en === 'string' ? s.disclaimer_en : DEFAULT_COMM_SETTINGS.disclaimer_en,
    disclaimer_it: typeof s.disclaimer_it === 'string' ? s.disclaimer_it : DEFAULT_COMM_SETTINGS.disclaimer_it,
    default_sla_days:
      typeof s.default_sla_days === 'number' && Number.isFinite(s.default_sla_days) && s.default_sla_days >= 0
        ? s.default_sla_days
        : DEFAULT_COMM_SETTINGS.default_sla_days,
    ai_enabled: typeof s.ai_enabled === 'boolean' ? s.ai_enabled : DEFAULT_COMM_SETTINGS.ai_enabled,
  }
}

/** Current settings (defaults merged under any stored overrides). */
export async function getCommSettings(): Promise<TdCommSettings> {
  const stored = await getAppSetting<Partial<TdCommSettings>>(TD_COMM_SETTINGS_KEY, {})
  return mergeCommSettings(stored)
}

/** Merge a patch over current settings and persist. Returns the new full settings. */
export async function setCommSettings(patch: Partial<TdCommSettings>): Promise<TdCommSettings> {
  const current = await getCommSettings()
  const next = mergeCommSettings({ ...current, ...patch })
  await setAppSetting(TD_COMM_SETTINGS_KEY, next)
  return next
}
