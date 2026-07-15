import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Council-approved Phase A hardening (2026-07-15):
 *  1. setConfiguredCardFeeRate must MERGE into the app_settings JSONB — a
 *     whole-object replace deletes `enabled:false` and silently re-arms the
 *     fee (isCardFeeEnabled defaults missing → ON).
 *  2. pinnedRateForInheritance — the offer-signed webhook's pass-through of
 *     the offer's pin into invoice creation. Must preserve an explicit 0
 *     (waived deal) and return undefined only when there is truly no pin.
 */

// In-memory app_settings store keyed by `key`.
let settingsStore: Record<string, Record<string, unknown>> = {}
const actionLogInserts: unknown[] = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      let capturedKey: string | null = null
      chain.select = () => chain
      chain.eq = (_col: string, val: string) => { capturedKey = val; return chain }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: capturedKey && settingsStore[capturedKey] !== undefined
            ? { value: settingsStore[capturedKey] }
            : null,
          error: null,
        })
      chain.upsert = (row: { key: string; value: Record<string, unknown> }) => {
        settingsStore[row.key] = row.value
        return Promise.resolve({ error: null })
      }
      chain.insert = (row: unknown) => {
        if (table === 'action_log') actionLogInserts.push(row)
        return Promise.resolve({ error: null })
      }
      return chain
    },
  },
}))

import {
  setConfiguredCardFeeRate,
  setCardFeeEnabled,
  isCardFeeEnabled,
  getConfiguredCardFeeRate,
  pinnedRateForInheritance,
  __resetCardFeeConfigCache,
} from '@/lib/payments/card-fee-config'

beforeEach(() => {
  settingsStore = {}
  actionLogInserts.length = 0
  __resetCardFeeConfigCache()
})

describe('setConfiguredCardFeeRate — merge, never replace (kill-switch clobber guard)', () => {
  it('preserves enabled:false when the rate is edited afterwards', async () => {
    await setCardFeeEnabled(false, 'qa')
    __resetCardFeeConfigCache()

    await setConfiguredCardFeeRate(0.04, 'qa')
    __resetCardFeeConfigCache()

    // The stored JSONB must still carry the OFF switch…
    expect(settingsStore['payment_fee_config']).toMatchObject({ enabled: false, card_rate: 0.04 })
    // …and the reader must still see the fee as OFF.
    expect(await isCardFeeEnabled()).toBe(false)
    expect(await getConfiguredCardFeeRate()).toBe(0.04)
  })

  it('preserves card_rate when the switch is flipped afterwards (reverse direction)', async () => {
    await setConfiguredCardFeeRate(0.03, 'qa')
    __resetCardFeeConfigCache()

    await setCardFeeEnabled(false, 'qa')
    __resetCardFeeConfigCache()

    expect(settingsStore['payment_fee_config']).toMatchObject({ enabled: false, card_rate: 0.03 })
    expect(await getConfiguredCardFeeRate()).toBe(0.03)
  })

  it('works when no settings row exists yet (merge from empty)', async () => {
    await setConfiguredCardFeeRate(0.05, 'qa')
    expect(settingsStore['payment_fee_config']).toMatchObject({ card_rate: 0.05 })
  })
})

describe('pinnedRateForInheritance — offer pin → invoice pass-through', () => {
  it('preserves an explicit 0 (a waived deal must stay waived)', () => {
    expect(pinnedRateForInheritance(0)).toBe(0)
    expect(pinnedRateForInheritance('0')).toBe(0)
    expect(pinnedRateForInheritance('0.0000')).toBe(0)
  })

  it('passes a normal pin through, numeric-column string included', () => {
    expect(pinnedRateForInheritance(0.05)).toBe(0.05)
    expect(pinnedRateForInheritance('0.0500')).toBe(0.05)
    expect(pinnedRateForInheritance(1)).toBe(1)
  })

  it('returns undefined when there is no usable pin (caller falls back to config)', () => {
    expect(pinnedRateForInheritance(null)).toBeUndefined()
    expect(pinnedRateForInheritance(undefined)).toBeUndefined()
    expect(pinnedRateForInheritance('')).toBeUndefined()
    expect(pinnedRateForInheritance('abc')).toBeUndefined()
    expect(pinnedRateForInheritance(NaN)).toBeUndefined()
    expect(pinnedRateForInheritance(-0.01)).toBeUndefined()
    expect(pinnedRateForInheritance(5)).toBeUndefined() // percent typo, not a fraction
  })
})

describe('setCardFeeEnabled — audit trail', () => {
  it('writes an action_log row with the actor', async () => {
    await setCardFeeEnabled(false, 'finance-ui:antonio@test')
    const entry = actionLogInserts.find(
      (r) => (r as { action_type?: string }).action_type === 'card_fee_enabled_changed',
    ) as { actor?: string } | undefined
    expect(entry).toBeDefined()
    expect(entry?.actor).toBe('finance-ui:antonio@test')
  })
})
