import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { uploadYearOptions } from '@/lib/tax/upload-year-options'

describe('uploadYearOptions', () => {
  it('2026, only a finished 2025 return: starts on 2025, still offers 2026', () => {
    expect(uploadYearOptions([{ tax_year: 2025, status: 'TR Filed' }], 2026)).toEqual({ years: [2026, 2025], defaultYear: 2025 })
  })
  it('2026, the 2025 return still open: starts on 2025', () => {
    expect(uploadYearOptions([{ tax_year: 2025, status: 'Wizard Available' }], 2026).defaultYear).toBe(2025)
  })
  it('next season: a new open 2026 record wins over the finished 2025 one', () => {
    const out = uploadYearOptions([{ tax_year: 2025, status: 'TR Filed' }, { tax_year: 2026, status: 'Paid - Not Started' }], 2027)
    expect(out).toEqual({ years: [2027, 2026, 2025], defaultYear: 2026 })
  })
  it('several open years: the OLDEST open one, like the tax wizard (back-filing collects oldest first)', () => {
    expect(uploadYearOptions([{ tax_year: 2024, status: 'Extension Filed' }, { tax_year: 2025, status: 'Extension Filed' }], 2026).defaultYear).toBe(2024)
  })
  it('a 2025 return in progress with a 2026 record already seeded starts on 2025, not 2026', () => {
    const out = uploadYearOptions([{ tax_year: 2025, status: 'Wizard Available' }, { tax_year: 2026, status: 'Not Invoiced' }], 2026)
    expect(out.defaultYear).toBe(2025)
  })
  it('all finished: the newest record year', () => {
    expect(uploadYearOptions([{ tax_year: 2024, status: 'TR Filed' }, { tax_year: 2025, status: 'Cancelled' }], 2026).defaultYear).toBe(2025)
  })
  it('no record at all: the year before today\'s, and that year IS in the list', () => {
    expect(uploadYearOptions([], 2026)).toEqual({ years: [2026, 2025], defaultYear: 2025 })
    expect(uploadYearOptions(null, 2027)).toEqual({ years: [2027, 2026], defaultYear: 2026 })
  })
  it('the starting year is always one of the listed years', () => {
    for (const recs of [[], [{ tax_year: 2025, status: 'TR Filed' }], [{ tax_year: 2024, status: 'Wizard Available' }, { tax_year: 2026, status: 'Not Invoiced' }]]) {
      const { years, defaultYear } = uploadYearOptions(recs, 2026)
      expect(years).toContain(defaultYear)
    }
  })
  it('ignores rows without a usable year', () => {
    expect(uploadYearOptions([{ tax_year: null, status: 'x' }, { tax_year: 2025, status: 'TR Filed' }], 2026).years).toEqual([2026, 2025])
  })
})

describe('wiring: the Tax Documents page and its upload box', () => {
  it('the page no longer puts the calendar year first, and passes the starting year', () => {
    const page = readFileSync('app/portal/tax-documents/page.tsx', 'utf8')
    expect(page).toContain('uploadYearOptions(taxReturns')
    expect(page).toContain('defaultTaxYear={defaultTaxYear}')
    expect(page).not.toContain('taxYears.unshift(currentYear)')
  })
  it('the upload box restarts when the client switches company (its starting year is read once)', () => {
    const page = readFileSync('app/portal/tax-documents/page.tsx', 'utf8')
    expect(page).toContain('<TaxDocumentUpload key={selectedAccountId}')
  })
  it('the box starts on the given year', () => {
    const box = readFileSync('components/portal/tax-document-upload.tsx', 'utf8')
    expect(box).toContain('defaultTaxYear ?? taxYears[0]')
  })
})
