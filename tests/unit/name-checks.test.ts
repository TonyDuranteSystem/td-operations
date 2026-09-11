import { describe, it, expect } from 'vitest'
import { initNameChecksFromWizard, parseProposedNames, hasFiledName, filedName, allNamesDead, confirmedClientFacingName, type NameCheck } from '@/lib/flows/name-checks'

describe('initNameChecksFromWizard', () => {
  it('builds entries from the numbered candidates, skipping empties', () => {
    const r = initNameChecksFromWizard({ llc_name_1: 'Aurora LLC', llc_name_2: '  ', llc_name_3: 'Cypress LLC' })
    expect(r).toEqual([
      { name: 'Aurora LLC', source: 'wizard', field: 'llc_name_1', status: 'pending', updated_at: null },
      { name: 'Cypress LLC', source: 'wizard', field: 'llc_name_3', status: 'pending', updated_at: null },
    ])
  })

  it('falls back to a single legacy name field', () => {
    expect(initNameChecksFromWizard({ company_name: 'Solo LLC' })).toEqual([
      { name: 'Solo LLC', source: 'wizard', field: 'company_name', status: 'pending', updated_at: null },
    ])
  })

  it('prefers numbered over legacy', () => {
    const r = initNameChecksFromWizard({ llc_name_1: 'Numbered LLC', company_name: 'Ignored LLC' })
    expect(r).toHaveLength(1)
    expect(r[0].name).toBe('Numbered LLC')
  })

  it('returns [] for null/empty', () => {
    expect(initNameChecksFromWizard(null)).toEqual([])
    expect(initNameChecksFromWizard({})).toEqual([])
  })
})

describe('parseProposedNames', () => {
  it('splits on newlines, commas, semicolons; trims; de-dupes; caps at 5', () => {
    expect(parseProposedNames('Alpha LLC, Beta LLC\nGamma LLC; alpha llc')).toEqual(['Alpha LLC', 'Beta LLC', 'Gamma LLC'])
    expect(parseProposedNames('a,b,c,d,e,f,g')).toHaveLength(5)
  })
  it('handles empty / non-string', () => {
    expect(parseProposedNames('')).toEqual([])
    expect(parseProposedNames('   ')).toEqual([])
    expect(parseProposedNames(undefined)).toEqual([])
    expect(parseProposedNames(42)).toEqual([])
  })
})

describe('hasFiledName', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }
  it('true only when a name is filed', () => {
    expect(hasFiledName([{ ...base, status: 'accepted' }])).toBe(false)
    expect(hasFiledName([{ ...base, status: 'available' }, { ...base, status: 'filed' }])).toBe(true)
    expect(hasFiledName([])).toBe(false)
    expect(hasFiledName(null)).toBe(false)
  })
})

describe('filedName', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }
  it('returns the filed candidate name', () => {
    expect(filedName([{ ...base, name: 'Acme LLC', status: 'available' }, { ...base, name: 'Marinela Marku LLC', status: 'filed' }])).toBe('Marinela Marku LLC')
  })
  it('returns null when nothing is filed', () => {
    expect(filedName([{ ...base, status: 'accepted' }])).toBeNull()
    expect(filedName([])).toBeNull()
    expect(filedName(null)).toBeNull()
    expect(filedName(undefined)).toBeNull()
  })
  it('returns null for a filed entry with a blank name', () => {
    expect(filedName([{ ...base, name: '   ', status: 'filed' }])).toBeNull()
  })
})

describe('allNamesDead', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }

  it('false on an empty list — nothing has died yet, not vacuously true (2026-09-10 fix)', () => {
    expect(allNamesDead([])).toBe(false)
    expect(allNamesDead(null)).toBe(false)
    expect(allNamesDead(undefined)).toBe(false)
  })

  it('false while any candidate is still in play (pending, available, sent_to_client, accepted, or filed)', () => {
    expect(allNamesDead([{ ...base, status: 'pending' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'pending' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'available' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'sent_to_client' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'accepted' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'filed' }])).toBe(false)
  })

  it('true only when every candidate is a dead end', () => {
    expect(allNamesDead([{ ...base, status: 'not_available' }])).toBe(true)
    expect(
      allNamesDead([
        { ...base, status: 'not_available' },
        { ...base, status: 'rejected_by_client' },
        { ...base, status: 'rejected_by_sos' },
      ]),
    ).toBe(true)
  })
})

describe('confirmedClientFacingName (2026-09-11, dev job cb771564)', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }

  it('null when nothing is real enough yet — pending/available/not_available/rejected are not shown to the client', () => {
    expect(confirmedClientFacingName([])).toBeNull()
    expect(confirmedClientFacingName(null)).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'pending' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'available' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'not_available' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'rejected_by_client' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'rejected_by_sos' }])).toBeNull()
  })

  it('shows a name the instant it is sent to the client for approval — the earliest real commitment', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'sent_to_client' }])).toBe('Lead Lift LLC')
  })

  it('shows an accepted name', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'accepted' }])).toBe('Lead Lift LLC')
  })

  it('shows a filed name', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'filed' }])).toBe('Lead Lift LLC')
  })

  it('prefers the most-advanced qualifying candidate when somehow more than one qualifies', () => {
    const checks: NameCheck[] = [
      { ...base, name: 'First Choice LLC', status: 'sent_to_client' },
      { ...base, name: 'Actually Filed LLC', status: 'filed' },
    ]
    expect(confirmedClientFacingName(checks)).toBe('Actually Filed LLC')
  })

  it('skips a blank name and falls through to a qualifying one', () => {
    expect(confirmedClientFacingName([{ ...base, name: '   ', status: 'filed' }])).toBeNull()
    expect(
      confirmedClientFacingName([
        { ...base, name: '   ', status: 'filed' },
        { ...base, name: 'Real Name LLC', status: 'accepted' },
      ]),
    ).toBe('Real Name LLC')
  })
})
