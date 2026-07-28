import { describe, it, expect } from 'vitest'
import { isUsCountry, classifyMember, deriveForeignPartners } from '@/lib/tax/foreign-partners'

describe('isUsCountry', () => {
  it('accepts the spellings production actually holds', () => {
    // All four seen in the live members table.
    for (const v of ['USA', 'United States', 'Stati Uniti', 'Florida']) {
      expect(isUsCountry(v)).toBe(true)
    }
    expect(isUsCountry('  united states of america ')).toBe(true)
    expect(isUsCountry('U.S.A.')).toBe(true)
  })

  it('rejects everything else, including blanks', () => {
    for (const v of ['Italy', 'Slovakia', 'United Kingdom', 'United Arab Emirates', '', null, undefined]) {
      expect(isUsCountry(v)).toBe(false)
    }
  })
})

describe('classifyMember — individuals', () => {
  const base = { kind: 'individual' as const, name: 'Test Person' }

  it('green card beats a foreign passport', () => {
    const v = classifyMember({ ...base, citizenship: 'Italy', residenceCountry: 'Italy', greenCard: true })
    expect(v.status).toBe('us')
  })

  it('US citizen living abroad is still American', () => {
    const v = classifyMember({ ...base, citizenship: 'United States', residenceCountry: 'Portugal', greenCard: false })
    expect(v.status).toBe('us')
  })

  it('foreign citizen living in the US is American for tax', () => {
    const v = classifyMember({ ...base, citizenship: 'Italy', residenceCountry: 'USA', greenCard: false })
    expect(v.status).toBe('us')
  })

  it('foreign citizen, foreign residence, no green card is foreign', () => {
    const v = classifyMember({ ...base, citizenship: 'Slovakia', residenceCountry: 'Slovakia', greenCard: false })
    expect(v.status).toBe('foreign')
  })

  it('NEVER guesses foreign when the green-card answer is missing', () => {
    const v = classifyMember({ ...base, citizenship: 'Slovakia', residenceCountry: 'Slovakia', greenCard: null })
    expect(v.status).toBe('unknown')
    expect(v.reason).toContain('green card')
  })

  it('is unknown when citizenship is blank', () => {
    const v = classifyMember({ ...base, citizenship: '', residenceCountry: 'Italy', greenCard: false })
    expect(v.status).toBe('unknown')
  })
})

describe('classifyMember — companies', () => {
  const base = { kind: 'company' as const, name: 'Holdco' }

  it('a US-formed company is American even if foreigners own it', () => {
    expect(classifyMember({ ...base, companyCountry: 'United States' }).status).toBe('us')
  })

  it('a company formed abroad is foreign', () => {
    expect(classifyMember({ ...base, companyCountry: 'United Kingdom' }).status).toBe('foreign')
  })

  it('is unknown without a country of formation', () => {
    expect(classifyMember({ ...base, companyCountry: null }).status).toBe('unknown')
  })

  it('does not apply the green-card rule to a company', () => {
    // A company has no citizenship/residence; only formation country counts.
    const v = classifyMember({ ...base, companyCountry: 'Italy', greenCard: true, citizenship: 'United States' })
    expect(v.status).toBe('foreign')
  })
})

describe('deriveForeignPartners', () => {
  it('Nexo shape: two foreign individuals → Yes', () => {
    const r = deriveForeignPartners([
      { kind: 'individual', name: 'Peter Papik', citizenship: 'Slovakia', residenceCountry: 'Slovakia', greenCard: false },
      { kind: 'individual', name: 'Radomir Knapec', citizenship: 'Slovakia', residenceCountry: 'Slovakia', greenCard: false },
    ])
    expect(r.hasForeignPartners).toBe(true)
    expect(r.foreignNames).toEqual(['Peter Papik', 'Radomir Knapec'])
  })

  it('mixed ownership still answers Yes — the US member does not cancel the foreign one', () => {
    const r = deriveForeignPartners([
      { kind: 'company', name: 'US Holdco', companyCountry: 'USA' },
      { kind: 'individual', name: 'Foreign Person', citizenship: 'Portugal', residenceCountry: 'Portugal', greenCard: false },
    ])
    expect(r.hasForeignPartners).toBe(true)
  })

  it('all-American members → No', () => {
    const r = deriveForeignPartners([
      { kind: 'individual', name: 'A', citizenship: 'United States', residenceCountry: 'USA', greenCard: false },
      { kind: 'company', name: 'B Inc', companyCountry: 'Florida' },
    ])
    expect(r.hasForeignPartners).toBe(false)
  })

  it('one confirmed foreign member settles it even while another is incomplete', () => {
    const r = deriveForeignPartners([
      { kind: 'individual', name: 'Known Foreign', citizenship: 'Italy', residenceCountry: 'Italy', greenCard: false },
      { kind: 'individual', name: 'Incomplete', citizenship: null, residenceCountry: null, greenCard: null },
    ])
    expect(r.hasForeignPartners).toBe(true)
    expect(r.unresolvedNames).toEqual(['Incomplete'])
  })

  it('refuses to answer when the only doubt could flip it', () => {
    const r = deriveForeignPartners([
      { kind: 'individual', name: 'A', citizenship: 'United States', residenceCountry: 'USA', greenCard: false },
      { kind: 'individual', name: 'B', citizenship: 'Italy', residenceCountry: 'Italy', greenCard: null },
    ])
    expect(r.hasForeignPartners).toBeNull()
    expect(r.summary).toContain('B')
  })

  it('no members recorded → no answer', () => {
    expect(deriveForeignPartners([]).hasForeignPartners).toBeNull()
  })
})
