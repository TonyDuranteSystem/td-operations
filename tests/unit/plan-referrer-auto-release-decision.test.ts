/**
 * Dev job e71d786c — the referrer's reward is issued AUTOMATICALLY once every part of a payment plan is paid in real cash.
 *
 * Pure decision + switch + messages. The per-deal sweep is in plan-referrer-sweep.test.ts, the release itself in
 * release-plan-commission.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  decidePlanReferrerAction,
  isPlanReferrerAutoReleaseEnabled,
  buildPlanReferrerAutoReleasedMessage,
  buildPlanReferrerAutoReleaseFailedMessage,
  buildPlanReferrerCashUnconfirmedMessage,
  type PlanReferrerActionInput,
} from '@/lib/notifications/plan-referrer-notify'

const base: PlanReferrerActionInput = {
  hasPayableReferrer: true,
  hasWorkingPartner: false,
  alreadyReleased: false,
  settlementEligible: true,
  allPartsMarkedPaid: true,
  referrerPinned: true,
  autoReleaseEnabled: true,
  autoAttemptAlreadyFailed: false,
}
const decide = (over: Partial<PlanReferrerActionInput> = {}) => decidePlanReferrerAction({ ...base, ...over })

describe('decidePlanReferrerAction — when the reward is issued by itself', () => {
  it('issues it automatically: pinned referrer, strict gate true, switch on, first attempt', () => {
    expect(decide()).toEqual({ do: 'auto_release' })
  })

  it('NEVER issues it while the strict cash gate is false, however the other flags look', () => {
    expect(decide({ settlementEligible: false, allPartsMarkedPaid: false })).toEqual({ do: 'skip', reason: 'not_yet_settled' })
    expect(decide({ settlementEligible: false, allPartsMarkedPaid: true })).toEqual({ do: 'notify_cash_unconfirmed', via: 'referrer' })
  })

  it('a typed-name referrer (no linked client) is never released automatically — a person is told', () => {
    expect(decide({ referrerPinned: false })).toEqual({ do: 'notify_ready', via: 'referrer' })
  })

  it('switch off: exactly the old behaviour (a note for a person), nothing issued', () => {
    expect(decide({ autoReleaseEnabled: false })).toEqual({ do: 'notify_ready', via: 'referrer' })
  })

  it('a managed partner payout is never automatic (it needs a person to approve it anyway)', () => {
    expect(decide({ hasPayableReferrer: false, hasWorkingPartner: true })).toEqual({ do: 'notify_ready', via: 'partner' })
    // structurally impossible upstream, but the tie-break is pinned: the partner wins, so no reward is auto-issued to the referrer
    expect(decide({ hasPayableReferrer: true, hasWorkingPartner: true })).toEqual({ do: 'notify_ready', via: 'partner' })
  })

  it('one automatic attempt per deal: after a failure the staff note stands and nothing retries on a loop', () => {
    expect(decide({ autoAttemptAlreadyFailed: true })).toEqual({ do: 'skip', reason: 'auto_attempt_failed_awaiting_staff' })
  })

  it('already released: nothing, ever', () => {
    expect(decide({ alreadyReleased: true })).toEqual({ do: 'skip', reason: 'already_released' })
  })

  it('nobody to pay: nothing', () => {
    expect(decide({ hasPayableReferrer: false, hasWorkingPartner: false })).toEqual({ do: 'skip', reason: 'no_payable_party' })
  })

  it('the cash-unconfirmed warning names the right party', () => {
    expect(decide({ settlementEligible: false, hasPayableReferrer: false, hasWorkingPartner: true })).toEqual({ do: 'notify_cash_unconfirmed', via: 'partner' })
  })

  it('the known-gap warning is not shown for a deal nobody can be paid on', () => {
    expect(decide({ settlementEligible: false, hasPayableReferrer: false, hasWorkingPartner: false })).toEqual({ do: 'skip', reason: 'no_payable_party' })
  })
})

describe('isPlanReferrerAutoReleaseEnabled — the on/off switch', () => {
  it('is ON when the setting is missing, empty or anything unrecognised (a typo can never switch the reward off)', () => {
    for (const v of [undefined, null, '', '   ', 'on', 'true', '1', 'yes', 'ofF-ish', 'enabled']) {
      expect(isPlanReferrerAutoReleaseEnabled(v as string | null | undefined)).toBe(true)
    }
  })
  it('is OFF only for an explicit off / false / 0 / no / disabled, in any case', () => {
    for (const v of ['off', 'OFF', ' Off ', 'false', 'FALSE', '0', 'no', 'disabled']) {
      expect(isPlanReferrerAutoReleaseEnabled(v)).toBe(false)
    }
  })
})

describe('staff messages', () => {
  it('the automatic-release note says who got what and that nothing is left to do', () => {
    const m = buildPlanReferrerAutoReleasedMessage({ clientName: 'Mario Rossi', referrerName: 'Acme LLC', amount: 300 })
    expect(m).toContain('Mario Rossi')
    expect(m).toContain('$300.00')
    expect(m).toContain('Acme LLC')
    expect(m).toMatch(/automatically/)
    expect(m).toMatch(/Nothing to do/)
  })
  it('works when the amount is unknown', () => {
    expect(buildPlanReferrerAutoReleasedMessage({ clientName: 'M', referrerName: 'A', amount: null })).toContain('the reward was issued automatically')
  })
  it('the failure note carries the reason, says what to do and that it will not retry by itself', () => {
    const m = buildPlanReferrerAutoReleaseFailedMessage({ clientName: 'Mario Rossi', reason: 'Referrer commission computed as 0' })
    expect(m).toContain('Referrer commission computed as 0')
    expect(m).toContain('Release commission')
    expect(m).toMatch(/will not be tried again/)
  })
  it('the cash-unconfirmed note says nothing was released and to check the bank first', () => {
    const m = buildPlanReferrerCashUnconfirmedMessage({ via: 'referrer', clientName: 'Mario Rossi' })
    expect(m).toMatch(/NOT released automatically/)
    expect(m).toMatch(/Check the bank/)
    expect(buildPlanReferrerCashUnconfirmedMessage({ via: 'partner', clientName: 'M' })).toContain("managed partner's payout")
  })
})
