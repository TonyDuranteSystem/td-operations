/**
 * Dev job 06a3c8e9 — the tax year on a Tax Return line must work in ANY offer, not only a tax-return offer (found by the 19 Nov 2026 production QA:
 * a "Tax Return 2026" line inside a closure offer created a job with no year and no tax record).
 * The behaviour was proven end to end on the sandbox; this pins the three gates that used to hide the year, so none comes back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('the tax year is read for every kind of offer', () => {
  it('activation: the year comes from the Tax Return line whatever the offer is led by — except formation / onboarding, which create their own', () => {
    const src = read('lib/operations/activate-service.ts')
    const line = src.split('\n').find((l) => /const statedTaxYear\s*=/.test(l))
    expect(line).toBeTruthy()
    expect(line).toMatch(/taxYearAppliesToOffer\(contractType\) \? taxYearOfOffer\(offer\?\.services\)\.year : null/)
    // a year in the future (an offer edited by hand skips the creation check) is never tracked
    expect(src).toMatch(/const offerTaxYear = statedTaxYear !== null && statedTaxYear <= new Date\(\)\.getFullYear\(\) \? statedTaxYear : null/)
  })

  it('creation check: judged for every offer that reads the year; formation / onboarding return early', () => {
    const src = read('lib/offers/tax-year-check.ts')
    expect(src).not.toMatch(/contractType\s*!==\s*'tax_return'\)\s*return none/)
    expect(src).toMatch(/if \(!taxYearAppliesToOffer\(input\.contractType\)\) return none/)
    // the offer's type also decides how two Tax Return lines are treated (refused on a tax-return offer, warned elsewhere)
    expect(src).toMatch(/contractType === 'tax_return' \? \{ error: msg/)
  })

  it('builder: the Tax year box shows on the Tax Return line of every offer that reads the year (not formation / onboarding)', () => {
    const src = read('components/offers/create-offer-dialog.tsx')
    const row = src.slice(src.indexOf('const taxYearRowProps'), src.indexOf('const updateServiceContext'))
    expect(row).toMatch(/svc\.pipeline === 'Tax Return' && taxYearAppliesToOffer\(derivedContractType\)/)
    // the line name carries the year for any such offer; only the DEFAULT (last year) is limited to a tax-return offer; a cleared box (0) is "none"
    expect(src).toMatch(/const lineYear = svc_cat\?\.pipeline === 'Tax Return' \? effectiveTaxYear\(s\.tax_year\) : undefined/)
    expect(src).toMatch(/if \(!taxYearAppliesToOffer\(derivedContractType\)\) return undefined/)
    expect(src).toMatch(/return taxYear \|\| \(derivedContractType === 'tax_return' \? new Date\(\)\.getFullYear\(\) - 1 : undefined\)/)
  })
})
