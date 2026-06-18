import { describe, it, expect } from 'vitest'
import { initNameChecksFromWizard, parseProposedNames, hasFiledName, type NameCheck } from '@/lib/flows/name-checks'

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
