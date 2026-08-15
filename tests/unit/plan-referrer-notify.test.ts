import { describe, it, expect } from 'vitest'
import { decidePlanReferrerNotification, buildPlanReferrerNotifyMessage } from '@/lib/notifications/plan-referrer-notify'

describe('decidePlanReferrerNotification', () => {
  it('notifies via referrer when a payable referrer exists, no working partner, and the plan is settled', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: true, hasWorkingPartner: false, alreadyReleased: false, settlementEligible: true,
    })
    expect(res).toEqual({ notify: true, via: 'referrer' })
  })

  it('notifies via partner when a working partner exists and the plan is settled', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: false, hasWorkingPartner: true, alreadyReleased: false, settlementEligible: true,
    })
    expect(res).toEqual({ notify: true, via: 'partner' })
  })

  it('prefers partner when (structurally impossible in practice, but) both flags are somehow true', () => {
    // shouldReleasePlanReferrerCredit/hasWorkingPartnerPayout are mutually exclusive by
    // construction upstream, so this input never occurs for real — this pins the
    // decision function's own tie-break rather than assuming the caller is always correct.
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: true, hasWorkingPartner: true, alreadyReleased: false, settlementEligible: true,
    })
    expect(res).toEqual({ notify: true, via: 'partner' })
  })

  it('does not notify when already released, even if everything else says yes', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: true, hasWorkingPartner: false, alreadyReleased: true, settlementEligible: true,
    })
    expect(res).toEqual({ notify: false, reason: 'already_released' })
  })

  it('does not notify when there is no payable referrer or partner', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: false, hasWorkingPartner: false, alreadyReleased: false, settlementEligible: true,
    })
    expect(res).toEqual({ notify: false, reason: 'no_payable_party' })
  })

  it('does not notify when the plan is not yet fully settled', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: true, hasWorkingPartner: false, alreadyReleased: false, settlementEligible: false,
    })
    expect(res).toEqual({ notify: false, reason: 'not_yet_settled' })
  })

  it('already_released is checked before payable-party (order of precedence)', () => {
    const res = decidePlanReferrerNotification({
      hasPayableReferrer: false, hasWorkingPartner: false, alreadyReleased: true, settlementEligible: false,
    })
    expect(res).toEqual({ notify: false, reason: 'already_released' })
  })
})

describe('buildPlanReferrerNotifyMessage', () => {
  it('names the referrer commission when via referrer', () => {
    expect(buildPlanReferrerNotifyMessage({ via: 'referrer', clientName: 'Riverside Consulting LLC' }))
      .toBe('Riverside Consulting LLC\'s payment plan is now fully paid — release the referrer\'s commission on the account page.')
  })

  it('names the partner payout when via partner', () => {
    expect(buildPlanReferrerNotifyMessage({ via: 'partner', clientName: 'Riverside Consulting LLC' }))
      .toBe('Riverside Consulting LLC\'s payment plan is now fully paid — release the managed partner\'s payout on the account page.')
  })
})
