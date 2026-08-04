/**
 * One definition of "who is a member", for categorisation.
 *
 * Member names decide owner draws, and they are matched by plain substring —
 * so a short name blanket-matches merchants. A member stored as "Ada" turns
 * Canada, Nevada and Amadeus into owner withdrawals across a whole year.
 *
 * The floor was first added to the categorisation engine ONLY, leaving the
 * portal ingest path with its own build. Two paths with two definitions is an
 * OSCILLATION once a periodic re-sort exists: ingest books a short-named
 * member's payments as draws, the sweep disagrees and rewrites them, the next
 * upload books them back — the client's capital accounts move every time
 * either path runs. Hence one module, and these tests.
 */

import { describe, it, expect } from 'vitest'
import {
  buildMemberNames, filterMemberNames, isUsableMemberName, MIN_MEMBER_NAME_LENGTH,
} from '@/lib/tax/member-names'

describe('isUsableMemberName — the single predicate', () => {
  it('accepts a real full name', () => {
    expect(isUsableMemberName('Lucia Terracciano')).toBe(true)
    expect(isUsableMemberName('Antonio Pezzella')).toBe(true)
  })

  // The whole point: too short to identify safely by substring.
  it('rejects the blanket-match hazard', () => {
    for (const n of ['Ada', 'Li', 'A', 'Jo', '']) {
      expect(isUsableMemberName(n)).toBe(false)
    }
  })

  it('ignores surrounding whitespace when measuring', () => {
    expect(isUsableMemberName('   Ada   ')).toBe(false)
    expect(isUsableMemberName('  Maria Rossi  ')).toBe(true)
  })

  it('matches the company-name floor it mirrors', () => {
    expect(MIN_MEMBER_NAME_LENGTH).toBe(5)
  })
})

describe('buildMemberNames — from contact rows', () => {
  it('joins first and last, drops the unusable', () => {
    expect(buildMemberNames([
      { first_name: 'Lucia', last_name: 'Terracciano' },
      { first_name: 'Ada', last_name: null },
      { first_name: null, last_name: null },
    ])).toEqual(['Lucia Terracciano'])
  })

  it('survives nulls in the list itself', () => {
    expect(buildMemberNames([null, undefined, { first_name: 'Maria', last_name: 'Rossi' }]))
      .toEqual(['Maria Rossi'])
  })

  it('a first name alone still counts when it is long enough to be safe', () => {
    expect(buildMemberNames([{ first_name: 'Alessandro', last_name: null }]))
      .toEqual(['Alessandro'])
  })
})

describe('filterMemberNames — from already-assembled names', () => {
  it('applies the identical rule to the workspace display_name shape', () => {
    expect(filterMemberNames(['Lucia Terracciano', 'Ada', null, '  ', 'Maria Rossi']))
      .toEqual(['Lucia Terracciano', 'Maria Rossi'])
  })
})

// The invariant that actually prevents the flip-flop.
describe('the two builders agree', () => {
  it('the same person is a member on BOTH paths, or on neither', () => {
    const cases: Array<{ first_name: string | null; last_name: string | null }> = [
      { first_name: 'Lucia', last_name: 'Terracciano' },
      { first_name: 'Ada', last_name: null },
      { first_name: 'Li', last_name: 'Wu' },
      { first_name: null, last_name: 'Pezzella' },
    ]
    for (const c of cases) {
      const viaContacts = buildMemberNames([c])
      const viaDisplayName = filterMemberNames([`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()])
      expect(viaContacts).toEqual(viaDisplayName)
    }
  })
})
