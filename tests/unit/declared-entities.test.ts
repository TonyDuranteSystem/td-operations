/**
 * Declared related entities (Phase 3R slice 4) — wizard answers → flag-only
 * related-party matching. Never a category; never own-entity nameVariants.
 */
import { describe, it, expect } from 'vitest'
import { declaredEntityNames } from '@/lib/tax/declared-entities'

describe('declaredEntityNames', () => {
  it('collects rpt_company_name values and other_owned_companies lines, deduped', () => {
    const names = declaredEntityNames({
      related_party_transactions: [
        { rpt_company_name: 'LOREA LLP' },
        { rpt_company_name: ' LOREA LLP ' },
        { rpt_company_name: 'Rossi Consulting SRL' },
      ],
      other_owned_companies: 'LOREA LLP\nMenorca Culinary; Beta GmbH',
    })
    expect(names).toContain('LOREA LLP')
    expect(names).toContain('Rossi Consulting SRL')
    expect(names).toContain('Menorca Culinary')
    expect(names).toContain('Beta GmbH')
    expect(names.filter(n => n === 'LOREA LLP')).toHaveLength(1)
  })

  it('drops blanks and too-short tokens; empty/missing data → []', () => {
    expect(declaredEntityNames({ other_owned_companies: ' , ab ,\n' })).toEqual([])
    expect(declaredEntityNames(null)).toEqual([])
    expect(declaredEntityNames({})).toEqual([])
  })
})
