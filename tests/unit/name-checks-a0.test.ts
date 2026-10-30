/**
 * Pure helpers added for the shared names-loop fixes (Company Change Name, track A0):
 * configurable name splitting, the client-answer de-dupe, and the per-status
 * transition table for staff actions. None of this changes what Formation did
 * before — the defaults are the old behaviour.
 */
import { describe, it, expect } from 'vitest'
import {
  parseProposedNames,
  addClientNames,
  nameActionProblem,
  NAME_ACTION_FROM,
  type NameCheck,
  type NameCheckStatus,
  type GuardedNameAction,
} from '@/lib/flows/name-checks'

const NOW = '2026-10-19T12:00:00.000Z'
const nc = (name: string, status: NameCheckStatus = 'pending'): NameCheck => ({ name, source: 'wizard', status, updated_at: null })

describe('parseProposedNames options', () => {
  it('default still splits on commas, semicolons and newlines (Formation behaviour unchanged)', () => {
    expect(parseProposedNames('A LLC, B LLC; C LLC\nD LLC')).toEqual(['A LLC', 'B LLC', 'C LLC', 'D LLC'])
  })

  it('"lines" keeps a comma inside a name ("Acme Holdings, LLC")', () => {
    expect(parseProposedNames('Acme Holdings, LLC\nBeta Trading, LLC', { separators: 'lines' })).toEqual([
      'Acme Holdings, LLC',
      'Beta Trading, LLC',
    ])
  })

  it('"lines" still splits on semicolons', () => {
    expect(parseProposedNames('One LLC; Two LLC', { separators: 'lines' })).toEqual(['One LLC', 'Two LLC'])
  })

  it('caps at 5 by default and at `max` when given', () => {
    const text = 'a\nb\nc\nd\ne\nf\ng'
    expect(parseProposedNames(text)).toHaveLength(5)
    expect(parseProposedNames(text, { max: 1 })).toEqual(['a'])
    expect(parseProposedNames(text, { max: 3, separators: 'lines' })).toEqual(['a', 'b', 'c'])
  })

  it('ignores a nonsense max and non-text input', () => {
    expect(parseProposedNames('a\nb', { max: 0 })).toEqual(['a', 'b'])
    expect(parseProposedNames(null)).toEqual([])
    expect(parseProposedNames(42 as unknown)).toEqual([])
  })
})

describe('addClientNames', () => {
  it('appends new names as pending client_resubmit entries', () => {
    const r = addClientNames([nc('Old LLC', 'not_available')], ['Fresh Name LLC'], NOW)
    expect(r.added).toEqual(['Fresh Name LLC'])
    expect(r.checks).toHaveLength(2)
    expect(r.checks[1]).toEqual({ name: 'Fresh Name LLC', source: 'client_resubmit', status: 'pending', updated_at: NOW })
  })

  it('does not bring back a name already tried, dead names included (case, punctuation and trailing LLC ignored)', () => {
    const r = addClientNames([nc('Acme Holdings LLC', 'rejected_by_sos'), nc('Beta', 'not_available')], ['ACME HOLDINGS', 'beta, llc', 'Gamma LLC'], NOW)
    expect(r.added).toEqual(['Gamma LLC'])
    expect(r.checks.map((c) => c.name)).toEqual(['Acme Holdings LLC', 'Beta', 'Gamma LLC'])
  })

  it('skips blanks, a bare "LLC" fragment and over-long names, and de-dupes inside the same answer', () => {
    const r = addClientNames([], ['  ', 'LLC', 'x'.repeat(500), 'Same LLC', 'same llc'], NOW)
    expect(r.added).toEqual(['Same LLC'])
  })

  it('does not mutate the list it was given', () => {
    const list = [nc('A LLC')]
    addClientNames(list, ['B LLC'], NOW)
    expect(list).toHaveLength(1)
  })

  it('treats a missing list as empty', () => {
    expect(addClientNames(null, ['A LLC'], NOW).checks).toHaveLength(1)
  })
})

describe('nameActionProblem (which status each staff action may start from)', () => {
  const ALL: NameCheckStatus[] = ['pending', 'available', 'not_available', 'sent_to_client', 'accepted', 'rejected_by_client', 'filed', 'rejected_by_sos']

  it('allows exactly the transitions the staff panel offers today', () => {
    const offered: Array<[GuardedNameAction, NameCheckStatus]> = [
      ['mark_available', 'pending'],
      ['mark_available', 'not_available'],
      ['mark_not_available', 'pending'],
      ['send_to_client', 'available'],
      ['mark_filed', 'accepted'],
      ['mark_sos_rejected', 'accepted'],
      ['mark_sos_rejected', 'filed'],
    ]
    for (const [action, status] of offered) expect(nameActionProblem(action, status)).toBeNull()
  })

  it('refuses every other combination with a plain-English reason', () => {
    for (const action of Object.keys(NAME_ACTION_FROM) as GuardedNameAction[]) {
      for (const status of ALL) {
        const allowed = NAME_ACTION_FROM[action].includes(status)
        const problem = nameActionProblem(action, status)
        if (allowed) expect(problem).toBeNull()
        else expect(problem).toMatch(/^Only a name /)
      }
    }
  })

  it('a refused name can never be re-marked filed or sent again', () => {
    expect(nameActionProblem('mark_filed', 'rejected_by_sos')).not.toBeNull()
    expect(nameActionProblem('send_to_client', 'rejected_by_sos')).not.toBeNull()
    expect(nameActionProblem('send_to_client', 'pending')).not.toBeNull()
  })

  it('withdraw only applies to a name waiting for the client', () => {
    expect(nameActionProblem('withdraw', 'sent_to_client')).toBeNull()
    expect(nameActionProblem('withdraw', 'available')).not.toBeNull()
    expect(nameActionProblem('withdraw', 'accepted')).not.toBeNull()
  })

  it('reinstate only applies to a name the CLIENT rejected — never one the state refused or that was filed', () => {
    expect(nameActionProblem('reinstate', 'rejected_by_client')).toBeNull()
    for (const st of ['pending', 'available', 'not_available', 'sent_to_client', 'accepted', 'filed', 'rejected_by_sos'] as const) {
      expect(nameActionProblem('reinstate', st)).not.toBeNull()
    }
  })

  it('an action it does not guard (add_name, request_new_names, unknown) is left to the caller', () => {
    expect(nameActionProblem('add_name' as unknown as GuardedNameAction, 'filed')).toBeNull()
    expect(nameActionProblem('bogus' as unknown as GuardedNameAction, 'pending')).toBeNull()
  })
})
