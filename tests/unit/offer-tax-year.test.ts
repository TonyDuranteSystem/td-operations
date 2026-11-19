/**
 * Dev job 0a60f416, part B — the tax YEAR of an offer's Tax Return line. The year lives in the line's name ("Tax Return 2026"); activation names the
 * delivery "Tax Return 2026 - <company>", which the repo's own reader (taxYearFromServiceName) already understands.
 */
import { describe, it, expect } from 'vitest'
import { lineNameWithYear, taxReturnServiceName, taxYearFromLineName, taxYearOfOffer, taxYearProblem } from '@/lib/offers/tax-year'
import { taxYearFromServiceName } from '@/lib/flows/resolve-flows'

describe('taxYearFromLineName', () => {
  it('reads the year after the words Tax Return', () => {
    expect(taxYearFromLineName('Tax Return 2026')).toBe(2026)
    expect(taxYearFromLineName('Solo Tax Return 2025')).toBe(2025)
    expect(taxYearFromLineName('tax return  2024')).toBe(2024)
  })
  it('never reads a year from anywhere else', () => {
    for (const n of ['Tax Return', 'Company Closure 2026', 'Regolarizzazione + Tax Return + Gestione 2026', 'Tax Return 20266', 'Studio 2024 Tax Return', '', null, undefined, 7]) {
      expect(taxYearFromLineName(n), String(n)).toBeNull()
    }
  })
})

describe('lineNameWithYear', () => {
  it('adds the year, or replaces one that is already there', () => {
    expect(lineNameWithYear('Tax Return', 2026)).toBe('Tax Return 2026')
    expect(lineNameWithYear('Tax Return 2025', 2026)).toBe('Tax Return 2026')
    expect(lineNameWithYear('', 2026)).toBe('Tax Return 2026')
  })
  it('what it writes is read back', () => {
    expect(taxYearFromLineName(lineNameWithYear('Tax Return', 2027))).toBe(2027)
  })
})

describe('taxYearOfOffer', () => {
  const closure = { name: 'Company Closure', price: '$700', contract_type: 'closure', pipeline_type: 'Company Closure' }
  it('finds the one Tax Return line and its year', () => {
    expect(taxYearOfOffer([closure, { name: 'Tax Return 2026', price: '$500', contract_type: 'tax_return' }])).toEqual({ year: 2026, lineCount: 1 })
  })
  it('a Tax Return line without a year = no year (the old behaviour is kept)', () => {
    expect(taxYearOfOffer([closure, { name: 'Tax Return', price: '$500', contract_type: 'tax_return' }])).toEqual({ year: null, lineCount: 1 })
  })
  it('two Tax Return lines are counted — they are refused at creation and blocked at activation', () => {
    expect(taxYearOfOffer([{ name: 'Tax Return 2024', pipeline_type: 'Tax Return' }, { name: 'Tax Return 2025', pipeline_type: 'Tax Return' }])).toEqual({ year: null, lineCount: 2 })
  })
  it('no Tax Return line, or services that are not a list', () => {
    expect(taxYearOfOffer([closure])).toEqual({ year: null, lineCount: 0 })
    expect(taxYearOfOffer(null)).toEqual({ year: null, lineCount: 0 })
    expect(taxYearOfOffer('nope')).toEqual({ year: null, lineCount: 0 })
  })
})

describe('taxReturnServiceName — the delivery name', () => {
  it('a stated year goes in, in the shape the repo\'s reader understands', () => {
    expect(taxReturnServiceName('Carasso Consulting LLC', 2026)).toBe('Tax Return 2026 - Carasso Consulting LLC')
    expect(taxYearFromServiceName(taxReturnServiceName('Acme LLC', 2026))).toBe(2026)
  })
  it('no year = exactly the old name', () => {
    expect(taxReturnServiceName('Acme LLC', null)).toBe('Tax Return - Acme LLC')
    expect(taxYearFromServiceName(taxReturnServiceName('Acme LLC', null))).toBeNull()
  })
  it('a company name that contains a year is never read as the tax year', () => {
    expect(taxYearFromServiceName(taxReturnServiceName('Studio 2024 LLC', null))).toBeNull()
    expect(taxYearFromServiceName(taxReturnServiceName('Studio 2024 LLC', 2026))).toBe(2026)
  })
})

describe('taxYearProblem', () => {
  const ctx = { currentYear: 2026 }
  it('this year and earlier years are fine', () => {
    expect(taxYearProblem(2026, ctx)).toBeNull()
    expect(taxYearProblem(2025, ctx)).toBeNull()
  })
  it('a year that has not started, or is not a year, is refused', () => {
    expect(taxYearProblem(2027, ctx)).toMatch(/not started/)
    expect(taxYearProblem(0, ctx)).toMatch(/not a tax year/)
    expect(taxYearProblem(2025.5, ctx)).toMatch(/not a tax year/)
  })
  it('a year before the company existed is refused (only when the formation year is known)', () => {
    expect(taxYearProblem(2025, { ...ctx, formationYear: 2026 })).toMatch(/formed in 2026/)
    expect(taxYearProblem(2026, { ...ctx, formationYear: 2026 })).toBeNull()
    expect(taxYearProblem(2020, { ...ctx, formationYear: null })).toBeNull()
  })
})
