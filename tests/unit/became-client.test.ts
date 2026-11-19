import { describe, it, expect } from 'vitest'
import {
  BECAME_CLIENT_LABEL,
  BECAME_CLIENT_VALUES,
  becameClientLabel,
  changeHeadsUp,
  checkedByName,
  etDay,
  evidenceLine,
  guessBecameClient,
  planConfirm,
  isBecameClientHow,
  type BecameClientFacts,
} from '@/lib/accounts/became-client'

const facts = (over: Partial<BecameClientFacts> = {}): BecameClientFacts => ({
  hasSignedFormationContract: false,
  hasSignedOnboardingContract: false,
  contractSignedAt: null,
  clientSince: null,
  hasFormationJob: false,
  ...over,
})

describe('the two answers', () => {
  it('are exactly Formed by us and Onboarded, in plain words', () => {
    expect([...BECAME_CLIENT_VALUES]).toEqual(['formed_by_us', 'onboarded'])
    expect(BECAME_CLIENT_LABEL).toEqual({ formed_by_us: 'Formed by us', onboarded: 'Onboarded' })
    expect(isBecameClientHow('onboarded')).toBe(true)
    expect(isBecameClientHow('formed')).toBe(false)
    expect(isBecameClientHow(null)).toBe(false)
    expect(isBecameClientHow(undefined)).toBe(false)
    expect(becameClientLabel('formed_by_us')).toBe('Formed by us')
    expect(becameClientLabel(null)).toBe('Not set')
    expect(becameClientLabel('nonsense')).toBe('Not set')
  })
})

describe('guessBecameClient — the signed contract comes first (Antonio: formation and onboarding come from the offer and the contract)', () => {
  it('a signed formation contract means formed by us, even when Client Since is filled', () => {
    const g = guessBecameClient(facts({ hasSignedFormationContract: true, contractSignedAt: '2026-05-27', clientSince: '2026-05-27' }))
    expect(g.value).toBe('formed_by_us')
    expect(g.basis).toBe('contract')
    expect(g.hint).toBe('The signed formation contract (May 27, 2026) says we formed it.')
  })

  it('a signed onboarding contract means onboarded, even when Client Since is empty', () => {
    const g = guessBecameClient(facts({ hasSignedOnboardingContract: true, contractSignedAt: '2026-02-12' }))
    expect(g.value).toBe('onboarded')
    expect(g.basis).toBe('contract')
    expect(g.hint).toBe('The signed onboarding contract (Feb 12, 2026) says it already existed.')
  })

  it('says nothing about a date it does not have', () => {
    expect(guessBecameClient(facts({ hasSignedFormationContract: true })).hint).toBe('The signed formation contract says we formed it.')
  })
})

describe('guessBecameClient — with no contract it follows Client Since (the rule of 2026-11-14)', () => {
  it('Client Since filled = onboarded; empty = formed by us', () => {
    expect(guessBecameClient(facts({ clientSince: '2026-04-18' })).value).toBe('onboarded')
    expect(guessBecameClient(facts({ clientSince: null, hasFormationJob: true })).value).toBe('formed_by_us')
  })

  it('flags the two cases where the data contradicts itself', () => {
    const a = guessBecameClient(facts({ clientSince: '2026-03-09', hasFormationJob: true }))
    expect(a.basis).toBe('conflict')
    expect(a.value).toBe('onboarded')
    expect(a.hint).toBe('Client Since is filled in (usually onboarded), but we also have a company formation job for it.')

    const b = guessBecameClient(facts({ clientSince: null, hasFormationJob: false }))
    expect(b.basis).toBe('conflict')
    expect(b.value).toBe('formed_by_us')
    expect(b.hint).toBe('Client Since is empty (usually formed by us), but we have no company formation job for it.')
  })

  it('the two agreeing cases are plain dates guesses, not conflicts', () => {
    expect(guessBecameClient(facts({ clientSince: '2026-04-18' })).basis).toBe('dates')
    expect(guessBecameClient(facts({ hasFormationJob: true })).basis).toBe('dates')
  })

  it('both contracts signed: falls back to the dates and says so', () => {
    const g = guessBecameClient(facts({ hasSignedFormationContract: true, hasSignedOnboardingContract: true, clientSince: '2026-01-05' }))
    expect(g.value).toBe('onboarded')
    expect(g.hint.startsWith('Both a formation and an onboarding contract are signed')).toBe(true)
  })
})

describe('changeHeadsUp — the amber line in the pop-up', () => {
  it('warns when Formed by us is picked but Client Since is filled', () => {
    expect(changeHeadsUp('formed_by_us', '2026-04-18')).toMatch(/usually means the company was onboarded/)
  })
  it('warns when Onboarded is picked but Client Since is empty', () => {
    expect(changeHeadsUp('onboarded', null)).toMatch(/usually means we formed the company/)
  })
  it('stays quiet when the answer fits Client Since', () => {
    expect(changeHeadsUp('onboarded', '2026-04-18')).toBeNull()
    expect(changeHeadsUp('formed_by_us', null)).toBeNull()
  })
})

describe('evidenceLine and planConfirm — what stands under "To check" and when "It\'s correct" needs a second look', () => {
  const formed = { value: 'formed_by_us' as const, hint: 'The signed formation contract (May 27, 2026) says we formed it.' }

  it('the guess agrees: just the hint, and confirming is direct (when Client Since fits)', () => {
    expect(evidenceLine('formed_by_us', formed)).toBe(formed.hint)
    expect(planConfirm('formed_by_us', formed, null)).toEqual({ direct: true, warnings: [] })
  })

  it('the shown answer is not the one the records point to: says so, and confirming opens the pop-up', () => {
    expect(evidenceLine('onboarded', formed)).toBe(`The records point to Formed by us instead. ${formed.hint}`)
    const plan = planConfirm('onboarded', formed, '2026-04-18')
    expect(plan.direct).toBe(false)
    expect(plan.warnings).toEqual([`The records point to Formed by us instead. ${formed.hint}`])
  })

  it('the contract could not be read: says so plainly, and confirming opens the pop-up', () => {
    expect(evidenceLine('onboarded', null)).toBe('The signed contract could not be read just now, so this answer was not compared with it. Reload the page to try again.')
    expect(planConfirm('onboarded', null, '2026-04-18').direct).toBe(false)
  })

  it('an answer that does not fit Client Since gets the Client Since warning even when the contract agrees', () => {
    const plan = planConfirm('formed_by_us', formed, '2026-04-18')
    expect(plan.direct).toBe(false)
    expect(plan.warnings).toEqual(['Client Since is filled in, and that usually means the company was onboarded, not formed by us.'])
  })

  it('two warnings when both apply', () => {
    expect(planConfirm('onboarded', formed, null).warnings).toHaveLength(2)
  })
})

describe('etDay — the business day in New York', () => {
  it('a UTC instant late in the evening New York time is still that New York day', () => {
    expect(etDay('2026-05-28T01:30:00Z')).toBe('2026-05-27') // 9:30 pm May 27 in New York
    expect(etDay('2026-12-05T04:59:59Z')).toBe('2026-12-04') // winter time: 11:59 pm Dec 4
    expect(etDay('2026-05-27T15:00:00+00:00')).toBe('2026-05-27')
  })
  it('a date without a time is left as it is', () => {
    expect(etDay('2026-05-27')).toBe('2026-05-27')
  })
  it('nothing or nonsense gives null', () => {
    expect(etDay(null)).toBeNull()
    expect(etDay(undefined)).toBeNull()
    expect(etDay('')).toBeNull()
    expect(etDay('not a date')).toBeNull()
  })
})

describe('checkedByName', () => {
  it('drops the dashboard: prefix', () => {
    expect(checkedByName('dashboard:antonio.durante')).toBe('antonio.durante')
    expect(checkedByName(null)).toBe('')
    expect(checkedByName('luca')).toBe('luca')
  })
})
