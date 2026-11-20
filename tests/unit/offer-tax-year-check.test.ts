/** Dev job 0a60f416, part B — what a new offer's Tax Return line is told at creation. The database is faked. */
import { describe, it, expect, vi } from 'vitest'

const state = { account: { formation_date: '2024-04-22' } as { formation_date: string | null } | null, tracked: null as { status: string; paid: boolean } | null }
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'accounts' ? state.account : null }),
          eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: state.tracked }) }) }),
        }),
      }),
    }),
  },
}))

import { checkTaxYearOnOffer } from '@/lib/offers/tax-year-check'

const now = new Date('2026-11-19T12:00:00Z')
const closure = { name: 'Company Closure', price: '$700', contract_type: 'closure' }
const tr = (name: string) => ({ name, price: '$500', contract_type: 'tax_return' })

describe('checkTaxYearOnOffer', () => {
  it('ANY offer whose Tax Return is created at payment is judged — a closure, an ITIN, a name change, a custom service… (job 06a3c8e9)', async () => {
    for (const contractType of ['closure', 'itin', 'company_change_name', 'custom_notary_pack', undefined]) {
      // a year that cannot exist is refused wherever the line sits
      expect((await checkTaxYearOnOffer({ contractType, services: [closure, tr('Tax Return 2027')], accountId: 'a', now })).error).toMatch(/not started/)
      // no year: warned, never refused
      const none = await checkTaxYearOnOffer({ contractType, services: [closure, tr('Tax Return')], accountId: 'a', now })
      expect(none.error).toBeNull()
      expect(none.warnings[0]).toMatch(/tracked as 2025/)
      // a good year: nothing said
      expect(await checkTaxYearOnOffer({ contractType, services: [closure, tr('Tax Return 2026')], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
    }
  })
  it('a FORMATION or ONBOARDING offer is never judged: their Tax Return is created later by the company\'s own setup, which picks its year', async () => {
    for (const contractType of ['formation', 'onboarding']) {
      expect(await checkTaxYearOnOffer({ contractType, services: [tr('Tax Return 2027')], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
      expect(await checkTaxYearOnOffer({ contractType, services: [tr('Tax Return')], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
      expect(await checkTaxYearOnOffer({ contractType, services: [tr('Tax Return 2025'), tr('Tax Return 2026')], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
    }
  })
  it('an offer with no Tax Return line is never judged', async () => {
    for (const contractType of ['formation', 'onboarding', 'closure', 'tax_return', undefined]) {
      expect(await checkTaxYearOnOffer({ contractType, services: [closure], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
    }
  })
  it('two Tax Return lines on a NON-tax-return offer are warned, not refused — such an offer is sold today and keeps working', async () => {
    for (const contractType of ['closure', 'itin', undefined]) {
      const r = await checkTaxYearOnOffer({ contractType, services: [tr('Tax Return 2025'), tr('Tax Return 2026')], accountId: 'a', now })
      expect(r.error).toBeNull()
      expect(r.warnings[0]).toMatch(/2 Tax Return lines/)
      expect(r.warnings[0]).toMatch(/will not be used/)
    }
  })
  it('two Tax Return lines are refused — one offer per year', async () => {
    const r = await checkTaxYearOnOffer({ contractType: 'tax_return', services: [tr('Tax Return 2024'), tr('Tax Return 2025')], accountId: 'a', now })
    expect(r.error).toMatch(/2 Tax Return lines.*one offer for each year/)
  })
  it('a line without a year only warns, and says what will happen', async () => {
    const r = await checkTaxYearOnOffer({ contractType: 'tax_return', services: [closure, tr('Tax Return')], accountId: 'a', now })
    expect(r.error).toBeNull()
    expect(r.warnings[0]).toMatch(/tracked as 2025/)
  })
  it('a year the company could have a return for passes clean', async () => {
    state.tracked = null
    expect(await checkTaxYearOnOffer({ contractType: 'tax_return', services: [closure, tr('Tax Return 2026')], accountId: 'a', now })).toEqual({ error: null, warnings: [] })
  })
  it('a year before the company was formed, or in the future, is refused', async () => {
    state.account = { formation_date: '2026-02-03' }
    expect((await checkTaxYearOnOffer({ contractType: 'tax_return', services: [tr('Tax Return 2025')], accountId: 'a', now })).error).toMatch(/formed in 2026/)
    expect((await checkTaxYearOnOffer({ contractType: 'tax_return', services: [tr('Tax Return 2027')], accountId: 'a', now })).error).toMatch(/not started/)
    state.account = { formation_date: '2024-04-22' }
  })
  it('a year already tracked as filed or paid warns (never blocks)', async () => {
    state.tracked = { status: 'TR Filed', paid: true }
    const r = await checkTaxYearOnOffer({ contractType: 'tax_return', services: [tr('Tax Return 2025')], accountId: 'a', now })
    expect(r.error).toBeNull()
    expect(r.warnings[0]).toMatch(/already has a 2025 tax return tracked/)
    state.tracked = null
  })
  it('no company yet (an offer for a person): the year is only range-checked', async () => {
    expect((await checkTaxYearOnOffer({ contractType: 'tax_return', services: [tr('Tax Return 2025')], accountId: null, now })).error).toBeNull()
  })
})
