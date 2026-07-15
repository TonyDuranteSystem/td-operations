/**
 * Card fee rate — resolve the configured/pinned rate. dev_task 6ec6872a.
 *
 * READ-DISCIPLINE INVARIANT (plan §5): the live config value (`app_settings`
 * `payment_fee_config.card_rate`) is read ONLY when an offer is created, or when an
 * offer-less invoice (renewal/manual) is created. It is NEVER read at charge time and
 * NEVER to display an already-pinned entity. At charge/display we read the PIN.
 *
 * Resolution: pinned value (offer's / invoice's) → live config → DEFAULT (5%).
 * Every failure path falls back — a payment must never break on a config miss.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { DEFAULT_CARD_FEE_RATE, normalizeRate } from './card-fee'

const SETTINGS_KEY = 'payment_fee_config'

/** Short cache — this sits on the client-facing payment path. */
let cached: { rate: number; at: number } | null = null
const TTL_MS = 60_000

/**
 * The current CONFIGURED rate. Call ONLY at creation time (new offer / offer-less
 * invoice) to STAMP a pin — never at charge or to display a pinned entity.
 */
export async function getConfiguredCardFeeRate(now: number = Date.now()): Promise<number> {
  if (cached && now - cached.at < TTL_MS) return cached.rate
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', SETTINGS_KEY)
      .maybeSingle()
    if (error || !data) return DEFAULT_CARD_FEE_RATE
    const raw = (data.value as { card_rate?: unknown } | null)?.card_rate
    const rate = normalizeRate(typeof raw === 'number' || typeof raw === 'string' ? raw : null)
    cached = { rate, at: now }
    return rate
  } catch {
    return DEFAULT_CARD_FEE_RATE
  }
}

/**
 * GLOBAL KILL SWITCH (dev_task 6ec6872a, go-live runbook). The card fee is charged
 * only when this is true. Because each deal PINS its rate at creation, flipping the
 * rate to 0 would NOT stop the fee on in-flight pinned deals — so the OFF switch is a
 * separate global flag the CHARGE path checks and, when false, charges the BASE
 * (effective rate 0) regardless of any pin. One action, NO redeploy: set
 * app_settings payment_fee_config.enabled = false. Defaults to TRUE when unset.
 */
export async function isCardFeeEnabled(now: number = Date.now()): Promise<boolean> {
  try {
    if (cachedEnabled && now - cachedEnabled.at < TTL_MS) return cachedEnabled.on
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', SETTINGS_KEY)
      .maybeSingle()
    if (error || !data) return true
    const raw = (data.value as { enabled?: unknown } | null)?.enabled
    const on = raw === false ? false : true // default ON unless explicitly false
    cachedEnabled = { on, at: now }
    return on
  } catch {
    return true // a config miss must not silently stop charging the fee
  }
}

let cachedEnabled: { on: boolean; at: number } | null = null

/** Flip the global kill switch. Logs to action_log. */
export async function setCardFeeEnabled(enabled: boolean, actor: string): Promise<void> {
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
      action_type: 'card_fee_enabled_changed',
      table_name: 'app_settings',
      summary: `Card processing fee turned ${enabled ? 'ON' : 'OFF'}`,
      details: { enabled },
    })
  } catch { /* audit best-effort */ }
}

/**
 * The rate to actually CHARGE for an offer/invoice: the pinned rate, OR 0 when the
 * global kill switch is off. Use this at checkout so the OFF switch overrides every pin.
 */
export async function resolveChargeRate(
  pinned: number | string | null | undefined,
): Promise<number> {
  if (!(await isCardFeeEnabled())) return 0
  return resolvePinnedRate(pinned)
}

/** Update the configured rate (CRM settings surface). Clamps + logs to action_log. */
export async function setConfiguredCardFeeRate(rate: number, actor: string): Promise<number> {
  const clamped = normalizeRate(rate)
  await supabaseAdmin
    .from('app_settings')
    .upsert({ key: SETTINGS_KEY, value: { card_rate: clamped }, updated_at: new Date().toISOString() })
  cached = null
  try {
    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'card_fee_rate_changed',
      table_name: 'app_settings',
      summary: `Card processing fee rate set to ${Math.round(clamped * 100)}%`,
      details: { card_rate: clamped },
    })
  } catch {
    /* audit is best-effort */
  }
  return clamped
}

/**
 * The rate that governs THIS entity — the PIN. Pass the row's `card_fee_rate`.
 * Falls back to the configured rate only when a row somehow has no pin (should not
 * happen post-backfill), then to DEFAULT. Use at charge AND display.
 */
export async function resolvePinnedRate(
  pinned: number | string | null | undefined,
): Promise<number> {
  const n = typeof pinned === 'string' ? Number(pinned) : pinned
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) return n
  return getConfiguredCardFeeRate()
}

export function __resetCardFeeConfigCache(): void {
  cached = null
  cachedEnabled = null
}
