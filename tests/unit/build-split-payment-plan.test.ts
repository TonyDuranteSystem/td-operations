import { describe, it, expect } from 'vitest'
import { buildSplitPaymentPlan, validatePaymentPlan } from '@/lib/offers/payment-plan'

describe('buildSplitPaymentPlan', () => {
  it('splits an even amount exactly in half, both parts summing to the gross', () => {
    const plan = buildSplitPaymentPlan(2500, 'EUR', '2026-08-27')
    expect(plan).toEqual([
      { seq: 1, amount: 1250, currency: 'EUR', trigger: { kind: 'signing' } },
      { seq: 2, amount: 1250, currency: 'EUR', trigger: { kind: 'date', date: '2026-09-26' } },
    ])
  })

  it('splits an odd-cent gross by subtraction, not by halving twice — no penny lost or invented', () => {
    const plan = buildSplitPaymentPlan(1000.01, 'USD', '2026-01-01') as Array<{ amount: number }>
    // Part 2 is whatever makes the two sum exactly right, never a second independent half —
    // halving 1000.01 twice (500.005 rounded each way) could otherwise land on 1000.00 or 1000.02.
    expect(plan[0].amount + plan[1].amount).toBe(1000.01)
  })

  it('the second part is due exactly 30 days after the given date', () => {
    const plan = buildSplitPaymentPlan(1000, 'USD', '2026-02-01') as Array<{ trigger: { date?: string } }>
    expect(plan[1].trigger.date).toBe('2026-03-03')
  })

  it('handles a month/year rollover correctly (UTC date arithmetic)', () => {
    const plan = buildSplitPaymentPlan(1000, 'USD', '2026-12-15') as Array<{ trigger: { date?: string } }>
    expect(plan[1].trigger.date).toBe('2027-01-14')
  })

  it('produces a plan that validatePaymentPlan actually accepts — no drift between the two', () => {
    const plan = buildSplitPaymentPlan(1750, 'EUR', '2026-08-27')
    const result = validatePaymentPlan(plan)
    expect(result.ok).toBe(true)
    expect(result.plan).toHaveLength(2)
  })
})
