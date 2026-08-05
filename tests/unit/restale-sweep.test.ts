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
  RESTALE_MAX_ACCOUNTS_PER_RUN, sweepBudgetExhausted, RESTALE_TIME_BUDGET_MS,
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

  // The SECOND signal. `confirmation_accepted` alone is not proof a return is
  // still open: the staff review loop has its own state, and a cron must not
  // re-sort numbers a client has finished with or a colleague is working on.
  it('NEVER a return marked confirmed in the review loop', () => {
    expect(decideRestale(c({ reviewStatuses: ['confirmed'] }))).toEqual({
      eligible: false, reason: 'staff_reviewing',
    })
  })

  it('NEVER while staff are actively reviewing', () => {
    expect(decideRestale(c({ reviewStatuses: ['under_review'] }))).toEqual({
      eligible: false, reason: 'staff_reviewing',
    })
  })

  // An account-year can carry several submission rows; one hands-off row is
  // enough to protect the whole year.
  it('one hands-off row among several protects the account-year', () => {
    expect(decideRestale(c({ reviewStatuses: ['submitted', null, 'confirmed'] })).eligible).toBe(false)
  })

  it('open review states stay eligible — that is the whole point', () => {
    for (const s of ['submitted', 'resubmitted', 'revision_requested', 'approved', 'reopened', null]) {
      expect(decideRestale(c({ reviewStatuses: [s] })).eligible).toBe(true)
    }
  })

  it('no submission row at all is still eligible (nothing to protect yet)', () => {
    expect(decideRestale(c({ reviewStatuses: [] })).eligible).toBe(true)
    expect(decideRestale(c({ reviewStatuses: undefined })).eligible).toBe(true)
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
    expect(RESTALE_MAX_ACCOUNTS_PER_RUN).toBeLessThanOrEqual(100)
  })

  // The cap is a runaway guard, not a batch size. There is no cursor, so a cap
  // below the number of eligible account-years starves the tail FOREVER — the
  // first cut capped at 8 against 16 real account-years and reprocessed the
  // same tiny ones every 4 hours while looking healthy.
  it('sits above the whole book, so nothing is starved', () => {
    const ACCOUNT_YEARS_IN_PRODUCTION = 16
    expect(RESTALE_MAX_ACCOUNTS_PER_RUN).toBeGreaterThan(ACCOUNT_YEARS_IN_PRODUCTION)
  })
})

/**
 * The runaway guard counts ACCOUNTS; the ceiling that bites is wall-clock.
 * Killed mid-loop, rows are already rewritten and the team post never runs —
 * the one thing this job promises never to do — and the fixed ordering means
 * every later run re-sweeps the same head and starves the tail.
 */
describe("sweepBudgetExhausted — the time door", () => {
  it("keeps going well inside the budget", () => {
    expect(sweepBudgetExhausted(0, 1_000)).toBe(false)
    expect(sweepBudgetExhausted(0, RESTALE_TIME_BUDGET_MS - 1)).toBe(false)
  })

  it("stops at the budget, before the platform kills the run", () => {
    expect(sweepBudgetExhausted(0, RESTALE_TIME_BUDGET_MS)).toBe(true)
    expect(sweepBudgetExhausted(0, RESTALE_TIME_BUDGET_MS + 60_000)).toBe(true)
  })

  it("leaves headroom under the route's own ceiling", () => {
    expect(RESTALE_TIME_BUDGET_MS).toBeLessThan(300_000)
  })
})

describe("describeRestaleResult — a mark-only run must not read as silence", () => {
  it("names owner questions when only marks moved", () => {
    const line = describeRestaleResult({ company: "LT Program LLC", taxYear: 2025, scanned: 900, changed: 0, marks: 3, dryRun: false })
    expect(line).toContain("3 owner questions")
  })

  it("says nothing extra when no mark moved", () => {
    const line = describeRestaleResult({ company: "LT Program LLC", taxYear: 2025, scanned: 900, changed: 4, marks: 0, dryRun: false })
    expect(line).not.toContain("owner question")
  })

  it("uses the singular for one", () => {
    expect(describeRestaleResult({ company: "X", taxYear: 2025, scanned: 1, changed: 0, marks: 1, dryRun: true }))
      .toContain("1 owner question ")
  })
})
