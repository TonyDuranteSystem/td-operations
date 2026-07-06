/**
 * IRS FX importer (fully-automatic rates) — parser + reconciliation tests over
 * a REAL slice of the irs.gov page (tests/fixtures/irs-fx-rates-2026-07.html),
 * which includes the page's own EUR-2024 decimal-comma cell ("0,924") that a
 * naive comma-strip turns into 924. Fail-closed paths: structural floor,
 * missing header, absurd values. Insert-only reconciliation: never overwrite.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseIrsRatesHtml,
  normalizeIrsRate,
  decideFxImport,
  IRS_CURRENCY_ISO,
  MIN_CURRENCIES,
  type IrsRate,
} from '@/lib/tax/irs-fx-import'

const FIXTURE = readFileSync(join(__dirname, '../fixtures/irs-fx-rates-2026-07.html'), 'utf8')

describe('normalizeIrsRate', () => {
  it('plain decimal', () => expect(normalizeIrsRate('0.924')).toBe(0.924))
  it('decimal comma (the real EUR-2024 page cell)', () => expect(normalizeIrsRate('0,924')).toBe(0.924))
  it('thousands separator with dot', () => expect(normalizeIrsRate('1,243.369')).toBe(1243.369))
  it("Venezuela's astronomical-but-real rate passes", () => expect(normalizeIrsRate('3833558362078.0')).toBe(3833558362078.0))
  it('rejects garbage and non-positive', () => {
    expect(() => normalizeIrsRate('n/a')).toThrow()
    expect(() => normalizeIrsRate('0')).toThrow()
    expect(() => normalizeIrsRate('-1.5')).toThrow()
  })
})

describe('parseIrsRatesHtml (real page fixture)', () => {
  const parsed = parseIrsRatesHtml(FIXTURE)

  it('reads the year columns from the header, not from assumptions (5 on the real page)', () => {
    expect(parsed.years).toEqual([2025, 2024, 2023, 2022, 2021])
  })
  it('parses every mapped currency for every year (minus quarantined cells)', () => {
    const currencies = new Set(parsed.rates.map(r => r.currency))
    expect(currencies.size).toBe(Object.keys(IRS_CURRENCY_ISO).length) // all 39 present in fixture
    expect(currencies.size).toBeGreaterThanOrEqual(MIN_CURRENCIES)
    expect(parsed.rates.length).toBe(currencies.size * 5 - parsed.badCells.length)
  })
  it('quarantines the real malformed Russia-2021 cell (".73.686") — skipped, not guessed', () => {
    expect(parsed.badCells).toEqual([{ key: 'Russia|Ruble', tax_year: 2021, raw: '.73.686' }])
    expect(parsed.rates.find(r => r.currency === 'RUB' && r.tax_year === 2021)).toBeUndefined()
    expect(parsed.rates.find(r => r.currency === 'RUB' && r.tax_year === 2024)?.rate_to_usd).toBe(92.837)
  })
  it('normalizes the EUR 2024 decimal-comma cell to 0.924 — never 924', () => {
    const eur2024 = parsed.rates.find(r => r.currency === 'EUR' && r.tax_year === 2024)
    expect(eur2024?.rate_to_usd).toBe(0.924)
  })
  it('official GBP values come through (the hand-entry drift detector)', () => {
    expect(parsed.rates.find(r => r.currency === 'GBP' && r.tax_year === 2025)?.rate_to_usd).toBe(0.759)
    expect(parsed.rates.find(r => r.currency === 'GBP' && r.tax_year === 2024)?.rate_to_usd).toBe(0.783)
  })
  it('reports nothing unmapped on the current page', () => {
    expect(parsed.unmapped).toEqual([])
  })
  it('an unknown country is surfaced as unmapped, not guessed', () => {
    const withNew = FIXTURE.replace('</table>',
      '<tr><td>Narnia</td><td>Lion</td><td>1.1</td><td>1.2</td><td>1.3</td><td>1.4</td><td>1.5</td></tr></table>')
    expect(parseIrsRatesHtml(withNew).unmapped).toEqual(['Narnia|Lion'])
  })
  it('fail-closed: truncated table under the currency floor throws, zero results', () => {
    // keep header + first 3 data rows only
    const rows = FIXTURE.match(/<tr[\s\S]*?<\/tr>/g)!
    const truncated = rows.slice(0, 4).join('')
    expect(() => parseIrsRatesHtml(truncated)).toThrow(/floor/)
  })
  it('fail-closed: page without the header row throws', () => {
    expect(() => parseIrsRatesHtml('<table><tr><td>hello</td><td>world</td><td>1</td></tr></table>')).toThrow(/header/)
  })
})

describe('decideFxImport (insert-only)', () => {
  const page: IrsRate[] = [
    { tax_year: 2026, currency: 'EUR', rate_to_usd: 0.9 },
    { tax_year: 2025, currency: 'EUR', rate_to_usd: 0.886 },
    { tax_year: 2025, currency: 'GBP', rate_to_usd: 0.759 },
  ]
  it('new (year,currency) pairs are inserts; matching rows are silent', () => {
    const d = decideFxImport(page, [
      { tax_year: 2025, currency: 'EUR', rate_to_usd: 0.886 },
      { tax_year: 2025, currency: 'GBP', rate_to_usd: 0.759 },
    ])
    expect(d.inserts).toEqual([{ tax_year: 2026, currency: 'EUR', rate_to_usd: 0.9 }])
    expect(d.diffs).toEqual([])
  })
  it('a stored value that drifted from the page is a DIFF, never an overwrite', () => {
    const d = decideFxImport(page, [
      { tax_year: 2025, currency: 'GBP', rate_to_usd: 0.795 }, // the real hand-entry case
      { tax_year: 2025, currency: 'EUR', rate_to_usd: 0.886 },
    ])
    expect(d.diffs).toEqual([{ tax_year: 2025, currency: 'GBP', stored: 0.795, page: 0.759 }])
    expect(d.inserts).toEqual([{ tax_year: 2026, currency: 'EUR', rate_to_usd: 0.9 }])
  })
  it('numeric-as-string stored values compare correctly', () => {
    const d = decideFxImport(page.slice(1, 2), [{ tax_year: 2025, currency: 'EUR', rate_to_usd: '0.886' }])
    expect(d.diffs).toEqual([])
    expect(d.inserts).toEqual([])
  })
})
