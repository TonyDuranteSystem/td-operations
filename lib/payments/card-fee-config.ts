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
}
