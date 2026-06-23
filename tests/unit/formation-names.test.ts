import { describe, it, expect } from 'vitest'
import { formationNameChoices, FORMATION_NAME_KEYS } from '@/lib/flows/formation-names'

describe('formationNameChoices', () => {
  it('returns three labeled slots when the numbered candidates are present', () => {
    const r = formationNameChoices({
      llc_name_1: 'Aurora Ventures',
      llc_name_2: 'Cypress Trail',
      llc_name_3: 'Nordstar Holdings',
    })
    expect(r).toEqual([
      { label: 'Name Choice 1', value: 'Aurora Ventures' },
      { label: 'Name Choice 2', value: 'Cypress Trail' },
      { label: 'Name Choice 3', value: 'Nordstar Holdings' },
    ])
  })

  it('keeps all three slots (null for empty) when only some candidates are filled', () => {
    // Marinela's shape: only llc_name_1 present.
    const r = formationNameChoices({ llc_name_1: 'Marinela Marku', chosen_name: 'Marinela Marku' })
    expect(r).toEqual([
      { label: 'Name Choice 1', value: 'Marinela Marku' },
      { label: 'Name Choice 2', value: null },
      { label: 'Name Choice 3', value: null },
    ])
  })

  it('NEVER surfaces a chosen name (no chosen concept at this stage)', () => {
    const r = formationNameChoices({ llc_name_1: 'A', chosen_name: 'A', chosen_name_final: 'A LLC' })
    expect(r.every((c) => c.label.startsWith('Name Choice'))).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/chosen/i)
  })

  it('falls back to a single "Proposed Name" for legacy single-name shapes', () => {
    expect(formationNameChoices({ llc_name: 'Solo LLC' })).toEqual([{ label: 'Proposed Name', value: 'Solo LLC' }])
    expect(formationNameChoices({ company_name: 'Co LLC' })).toEqual([{ label: 'Proposed Name', value: 'Co LLC' }])
    expect(formationNameChoices({ business_name: 'Biz LLC' })).toEqual([{ label: 'Proposed Name', value: 'Biz LLC' }])
  })

  it('prefers numbered candidates over the single-name fallback', () => {
    const r = formationNameChoices({ llc_name_1: 'Numbered LLC', company_name: 'Ignored LLC' })
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual({ label: 'Name Choice 1', value: 'Numbered LLC' })
  })

  it('treats whitespace-only candidates as empty', () => {
    const r = formationNameChoices({ llc_name_1: 'Real', llc_name_2: '   ' })
    expect(r[1].value).toBeNull()
  })

  it('returns [] for null / empty input', () => {
    expect(formationNameChoices(null)).toEqual([])
    expect(formationNameChoices({})).toEqual([])
  })

  it('excludes chosen_name and chosen_name_final from the grouped view', () => {
    expect(FORMATION_NAME_KEYS).toContain('llc_name_1')
    expect(FORMATION_NAME_KEYS).toContain('chosen_name')
    expect(FORMATION_NAME_KEYS).toContain('chosen_name_final')
  })
})
