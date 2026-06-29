import { describe, it, expect } from 'vitest'
import {
  normalizeBankName,
  bankSlug,
  findGuide,
  deriveMatchTerms,
  genericGuideSteps,
  validateGuide,
  buildGuidePrompt,
  type BankGuide,
} from '@/lib/tax/bank-guide'

const guides: BankGuide[] = [
  { name: 'Mercury', matchTerms: ['mercury'], stepsEn: ['a', 'b'], stepsIt: ['x', 'y'], noteEn: 'n', noteIt: 'nn' },
  { name: 'N26', matchTerms: ['n26'], stepsEn: ['a', 'b'], stepsIt: [], noteEn: '', noteIt: '' },
  { name: 'Bank of America', matchTerms: ['bank of america', 'bofa'], stepsEn: ['a', 'b'], stepsIt: [], noteEn: '', noteIt: '' },
]

describe('normalizeBankName', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeBankName('  Bank   OF  America ')).toBe('bank of america')
  })
  it('strips punctuation but keeps & . -', () => {
    expect(normalizeBankName('AT&T, Inc.')).toBe('at&t inc.')
  })
  it('handles null/undefined', () => {
    expect(normalizeBankName(undefined as unknown as string)).toBe('')
  })
})

describe('bankSlug', () => {
  it('kebab-cases', () => {
    expect(bankSlug('Bank of America')).toBe('bank-of-america')
    expect(bankSlug('N26!')).toBe('n26')
  })
})

describe('findGuide', () => {
  it('matches an exact bank name', () => {
    expect(findGuide('Mercury', guides)?.name).toBe('Mercury')
  })
  it('matches a substring/typed phrase', () => {
    expect(findGuide('my mercury account', guides)?.name).toBe('Mercury')
  })
  it('matches an alias term', () => {
    expect(findGuide('bofa', guides)?.name).toBe('Bank of America')
  })
  it('prefers the longer (more specific) term', () => {
    const g = [
      { name: 'N2 Bank', matchTerms: ['n2'], stepsEn: ['a'], stepsIt: [], noteEn: '', noteIt: '' },
      { name: 'N26', matchTerms: ['n26'], stepsEn: ['a'], stepsIt: [], noteEn: '', noteIt: '' },
    ]
    expect(findGuide('n26', g)?.name).toBe('N26')
  })
  it('returns null for no match', () => {
    expect(findGuide('zzz unknown', guides)).toBeNull()
  })
  it('returns null for too-short query', () => {
    expect(findGuide('m', guides)).toBeNull()
  })
})

describe('deriveMatchTerms', () => {
  it('includes full name + word tokens, drops noise', () => {
    expect(deriveMatchTerms('N26 Bank')).toEqual(['n26 bank', 'n26'])
  })
  it('dedupes single-word names', () => {
    expect(deriveMatchTerms('Wise')).toEqual(['wise'])
  })
})

describe('genericGuideSteps', () => {
  it('returns English steps + note', () => {
    const g = genericGuideSteps('en')
    expect(g.steps.length).toBeGreaterThanOrEqual(3)
    expect(g.note).toMatch(/Excel|spreadsheet/i)
  })
  it('returns Italian steps for it', () => {
    const g = genericGuideSteps('it')
    expect(g.steps[0]).toMatch(/Accedi/)
  })
})

describe('validateGuide', () => {
  it('accepts a well-formed guide', () => {
    const g = validateGuide(
      { display_name: 'Revolut', is_real_bank: true, steps_en: ['s1', 's2', 's3'], steps_it: ['p1', 'p2'], note_en: 'note' },
      'revolut',
    )
    expect(g?.name).toBe('Revolut')
    expect(g?.stepsEn).toHaveLength(3)
    expect(g?.matchTerms).toContain('revolut')
  })
  it('rejects when is_real_bank is false', () => {
    expect(validateGuide({ is_real_bank: false, steps_en: ['s1', 's2'] }, 'asdf')).toBeNull()
  })
  it('rejects when fewer than 2 steps', () => {
    expect(validateGuide({ is_real_bank: true, steps_en: ['only one'], display_name: 'X' }, 'x')).toBeNull()
  })
  it('falls back to English steps when Italian missing', () => {
    const g = validateGuide({ display_name: 'Wise', is_real_bank: true, steps_en: ['a', 'b'] }, 'wise')
    expect(g?.stepsIt).toEqual(['a', 'b'])
  })
  it('clamps to 8 steps and 240 chars', () => {
    const many = Array.from({ length: 12 }, (_, i) => 'x'.repeat(300) + i)
    const g = validateGuide({ display_name: 'Big', is_real_bank: true, steps_en: many }, 'big')
    expect(g?.stepsEn).toHaveLength(8)
    expect(g?.stepsEn[0].length).toBe(240)
  })
  it('uses fallback name when display_name empty', () => {
    const g = validateGuide({ is_real_bank: true, steps_en: ['a', 'b'] }, 'My Local Bank')
    expect(g?.name).toBe('My Local Bank')
  })
})

describe('buildGuidePrompt', () => {
  it('includes the bank name and CSV intent', () => {
    const p = buildGuidePrompt('Chase')
    expect(p).toContain('Chase')
    expect(p).toMatch(/CSV/)
  })
})
