import { describe, it, expect } from 'vitest'
import { extractFormationNames, FORMATION_NAME_KEYS } from '@/lib/flows/formation-names'

describe('extractFormationNames', () => {
  it('returns the three numbered candidates in order', () => {
    const r = extractFormationNames({
      llc_name_1: 'Acme Ventures LLC',
      llc_name_2: 'Acme Holdings LLC',
      llc_name_3: 'Acme Group LLC',
    })
    expect(r.choices).toEqual(['Acme Ventures LLC', 'Acme Holdings LLC', 'Acme Group LLC'])
    expect(r.chosen).toBeNull()
  })

  it('marks the chosen name', () => {
    const r = extractFormationNames({
      llc_name_1: 'First LLC',
      llc_name_2: 'Second LLC',
      chosen_name: 'Second LLC',
    })
    expect(r.choices).toEqual(['First LLC', 'Second LLC'])
    expect(r.chosen).toBe('Second LLC')
  })

  it('falls back to a single name shape when no numbered candidates', () => {
    expect(extractFormationNames({ llc_name: 'Solo LLC' }).choices).toEqual(['Solo LLC'])
    expect(extractFormationNames({ company_name: 'Co LLC' }).choices).toEqual(['Co LLC'])
    expect(extractFormationNames({ business_name: 'Biz LLC' }).choices).toEqual(['Biz LLC'])
  })

  it('prefers numbered candidates over the single-name fallback', () => {
    const r = extractFormationNames({ llc_name_1: 'Numbered LLC', company_name: 'Ignored LLC' })
    expect(r.choices).toEqual(['Numbered LLC'])
  })

  it('de-duplicates and drops empty/whitespace candidates', () => {
    const r = extractFormationNames({
      llc_name_1: 'Dup LLC',
      llc_name_2: '   ',
      llc_name_3: 'Dup LLC',
    })
    expect(r.choices).toEqual(['Dup LLC'])
  })

  it('handles null / empty input', () => {
    expect(extractFormationNames(null)).toEqual({ choices: [], chosen: null })
    expect(extractFormationNames({})).toEqual({ choices: [], chosen: null })
  })

  it('exposes the name keys consumed (for exclusion from the grouped view)', () => {
    expect(FORMATION_NAME_KEYS).toContain('llc_name_1')
    expect(FORMATION_NAME_KEYS).toContain('chosen_name')
  })
})
