/**
 * Card-autopay kill switch (dev job 10995181).
 *
 * Unlike lib/payments/card-fee-config.ts's fee toggle, this DEFAULTS OFF:
 * card autopay is genuinely new unattended-charging infrastructure, so the
 * absence of a config row must mean "not live yet," never "on by default."
 * Checked by the enrollment endpoint (refuse new enrollments while off) and
 * the auto-charge cron (skip entirely while off), on top of each account's
 * own accounts.autopay_card_enabled flag.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

const SETTINGS_KEY = 'card_autopay_config'
const TTL_MS = 60_000

let cachedEnabled: { on: boolean; at: number } | null = null

export async function isCardAutopayEnabled(now: number = Date.now()): Promise<boolean> {
  try {
    if (cachedEnabled && now - cachedEnabled.at < TTL_MS) return cachedEnabled.on
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', SETTINGS_KEY)
      .maybeSingle()
    if (error || !data) return false
    const raw = (data.value as { enabled?: unknown } | null)?.enabled
    const on = raw === true
    cachedEnabled = { on, at: now }
    return on
  } catch {
    return false
  }
}

/** Flip the global kill switch. Logs to action_log. */
export async function setCardAutopayEnabled(enabled: boolean, actor: string): Promise<void> {
  const { data } = await supabaseAdmin.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
  const current = (data?.value as Record<string, unknown> | null) ?? {}
  await supabaseAdmin.from('app_settings').upsert({
    key: SETTINGS_KEY,
    value: { ...current, enabled },
    updated_at: new Date().toISOString(),
  })
  cachedEnabled = null
  try {
    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'card_autopay_enabled_changed',
      table_name: 'app_settings',
      summary: `Card autopay turned ${enabled ? 'ON' : 'OFF'}`,
      details: { enabled },
    })
  } catch { /* audit best-effort */ }
}

export function __resetCardAutopayConfigCache(): void {
  cachedEnabled = null
}
