/**
 * Who the stale-classification sweep may re-sort.
 *
 * Origin (2026-08-03): five payments to Lucia Terracciano and Antonio Pezzella
 * sat as "internal transfers" instead of owner draws for weeks, because both
 * were linked as contacts on their accounts AFTER their statements were
 * ingested — and nothing re-runs the sort when a client's record improves.
 */

import { describe, it, expect } from 'vitest'
import {
  decideRestale, describeRestaleResult, restaleIsDryRun,
  RESTALE_MAX_ACCOUNTS_PER_RUN,
} from '@/lib/tax/restale-sweep'

const c = (over: Partial<Parameters<typeof decideRestale>[0]> = {}) => ({
  account_id: 'a', tax_year: 2025, transactions: 100, confirmed: false, ...over,
})

describe('decideRestale — who may be re-sorted', () => {
  it('an open return with transactions is eligible', () => {
    expect(decideRestale(c())).toEqual({ eligible: true, reason: 'eligible' })
  })

  // The hard line. Moving a figure after the client signed off changes what
  // they attested to; that correction is staff reopening the return, not a cron.
  it('NEVER a confirmed return', () => {
    expect(decideRestale(c({ confirmed: true }))).toEqual({
      eligible: false, reason: 'already_confirmed',
    })
  })

  it('confirmed wins even with plenty of transactions', () => {
    expect(decideRestale(c({ confirmed: true, transactions: 10_000 })).eligible).toBe(false)
  })

  it('nothing to sort → skipped', () => {
    expect(decideRestale(c({ transactions: 0 }))).toEqual({
      eligible: false, reason: 'no_transactions',
    })
  })
})

describe('restaleIsDryRun — report-only unless explicitly switched off', () => {
  it('report-only when unset', () => {
    expect(restaleIsDryRun({})).toBe(true)
  })
  it('report-only for anything other than the exact string "false"', () => {
    for (const v of ['true', 'FALSE', '0', 'no', '']) {
      expect(restaleIsDryRun({ TAX_RESTALE_SWEEP_DRY_RUN: v })).toBe(true)
    }
  })
  it('writes only on the exact string "false"', () => {
    expect(restaleIsDryRun({ TAX_RESTALE_SWEEP_DRY_RUN: 'false' })).toBe(false)
  })
})

describe('describeRestaleResult — the line a human reads', () => {
  it('says WOULD change in report-only mode', () => {
    expect(describeRestaleResult({ company: 'LT Program LLC', taxYear: 2025, scanned: 210, changed: 3, dryRun: true }))
      .toBe('LT Program LLC 2025: would change 3 of 210')
  })
  it('says changed when it really wrote', () => {
    expect(describeRestaleResult({ company: 'LT Program LLC', taxYear: 2025, scanned: 210, changed: 3, dryRun: false }))
      .toBe('LT Program LLC 2025: changed 3 of 210')
  })
})

describe('run cap', () => {
  it('is bounded so one tick can never run away', () => {
    expect(RESTALE_MAX_ACCOUNTS_PER_RUN).toBeGreaterThan(0)
    expect(RESTALE_MAX_ACCOUNTS_PER_RUN).toBeLessThanOrEqual(25)
  })
})
