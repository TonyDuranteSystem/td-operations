import { describe, it, expect } from 'vitest'
import { buildContractUpdate, displayContractAmounts, readContractAmounts } from '@/lib/signed-contracts/contract-amounts'
import { amountFromSavedText, applyRenewalAmounts, readRenewalAmounts } from '@/lib/signed-contracts/renewal-amounts'
import { contractLabel, hasInstallmentAmounts } from '@/lib/signed-contracts/labels'

describe('amounts saved on a formation / onboarding contract', () => {
  it('reads what the signing page writes', () => {
    const s = readContractAmounts('2500', '{"jan":1250,"jun":1250}')
    expect(s).toEqual({ january: 1250, june: 1250, yearlyRaw: '2500', unreadable: false })
    expect(displayContractAmounts(s, '$')).toEqual({ january: '$1,250', june: '$1,250', yearly: '$2,500' })
  })

  it('shows a wrong saved value as it is (the glued number is visible, not hidden)', () => {
    const s = readContractAmounts('200010001000', '{"jan":200010001000,"jun":0}')
    expect(displayContractAmounts(s, '$')).toEqual({ january: '$200,010,001,000', june: '$0', yearly: '$200,010,001,000' })
  })

  it('shows the saved yearly figure, not January + June, so a disagreement is visible', () => {
    const s = readContractAmounts('2000', '{"jan":1250,"jun":1250}')
    expect(displayContractAmounts(s, '$').yearly).toBe('$2,000')
  })

  it('never rounds a saved value into a plausible one (2.5001 stays 2.5001)', () => {
    const s = readContractAmounts('2.5001', null)
    expect(displayContractAmounts(s, '$').yearly).toBe('$2.5001')
    const t = readContractAmounts('2500.123456', '{"jan":1.25,"jun":0.1}')
    expect(displayContractAmounts(t, '').january).toBe('1.25')
    expect(displayContractAmounts(t, '').june).toBe('0.1')
  })

  it('says "nothing saved" instead of inventing a value', () => {
    const s = readContractAmounts(null, null)
    expect(displayContractAmounts(s, '$')).toEqual({ january: 'nothing saved', june: 'nothing saved', yearly: null })
  })

  it('a yearly figure that is not a number is shown as saved', () => {
    const s = readContractAmounts('2.5001abc', null)
    expect(displayContractAmounts(s, '').yearly).toBe('2.5001abc')
  })

  it('flags installments it cannot read', () => {
    expect(readContractAmounts('2500', 'not json').unreadable).toBe(true)
    expect(readContractAmounts('2500', '{"jan":"1250","jun":1250}').unreadable).toBe(true)
    expect(readContractAmounts('2500', { jan: 1, jun: 2 })).toMatchObject({ january: 1, june: 2, unreadable: false })
  })

  it('writes an edit in the exact shape the signing page writes', () => {
    const u = buildContractUpdate(1250, 1250)
    expect(u).toEqual({ annual_fee: '2500', installments: '{"jan":1250,"jun":1250}' })
    // the signing sanitizer's own rule for annual_fee
    expect(/^\d+(\.\d+)?$/.test(u.annual_fee)).toBe(true)
    expect(buildContractUpdate(1000.5, 999.5).annual_fee).toBe('2000')
    expect(buildContractUpdate(849, 1000)).toEqual({ annual_fee: '1849', installments: '{"jan":849,"jun":1000}' })
    expect(buildContractUpdate(600, 0).installments).toBe('{"jan":600,"jun":0}')
  })
})

const twoGroups = () => [
  { label: 'First Installment (January)', items: [{ name: 'Annual Management', price: '$1,000' }], total: '$1,000' },
  { label: 'Second Installment (June)', items: [{ name: 'Annual Management', price: '$1,000' }], total: '$1,000' },
]
const oneGroup = () => [
  { label: '2026 Payment Schedule', total: '$2,000', items: [{ name: 'First Installment (January)', price: '$1,000' }, { name: 'Second Installment (June)', price: '$1,000' }] },
]

describe('amounts saved on an annual renewal agreement', () => {
  it('reads the two real layouts', () => {
    expect(readRenewalAmounts(twoGroups())).toMatchObject({ layout: 'two-groups', january: '$1,000', june: '$1,000', editable: true })
    expect(readRenewalAmounts(oneGroup())).toMatchObject({ layout: 'one-group', january: '$1,000', june: '$1,000', editable: true })
  })

  it('does not guess at any other layout', () => {
    const skipJanuary = [
      { label: 'First Installment (June)', items: [{ name: 'Annual Management', price: '$900' }], total: '$900' },
      { label: 'Second Installment (June — Year 3+)', items: [{ name: 'Annual Management', price: '$900' }], total: '$900' },
    ]
    const r = readRenewalAmounts(skipJanuary)
    expect(r.layout).toBe('other')
    expect(r.editable).toBe(false)
    expect(r.lines.length).toBeGreaterThan(0)
    expect(applyRenewalAmounts(skipJanuary, 1, 2)).toBeNull()
    expect(readRenewalAmounts(null).layout).toBe('other')
    expect(readRenewalAmounts('x').layout).toBe('other')
    expect(readRenewalAmounts([]).editable).toBe(false)
  })

  it('rewrites two groups the way the agreement was written', () => {
    const next = applyRenewalAmounts(twoGroups(), 1250, 849) as ReturnType<typeof twoGroups>
    expect(next[0].total).toBe('$1,250')
    expect(next[0].items[0].price).toBe('$1,250')
    expect(next[1].total).toBe('$849')
    expect(next[1].items[0].price).toBe('$849')
    expect(next[0].label).toBe('First Installment (January)')
  })

  it('rewrites one group and its sum', () => {
    const next = applyRenewalAmounts(oneGroup(), 1250, 1250) as ReturnType<typeof oneGroup>
    expect(next[0].items[0].price).toBe('$1,250')
    expect(next[0].items[1].price).toBe('$1,250')
    expect(next[0].total).toBe('$2,500')
  })

  it('never changes the saved record it was given, and keeps the currency it was written in', () => {
    const original = twoGroups()
    const frozen = JSON.stringify(original)
    applyRenewalAmounts(original, 5, 6)
    expect(JSON.stringify(original)).toBe(frozen)
    const euro = [
      { label: 'First Installment (January)', items: [{ name: 'A', price: '€1,000' }], total: '€1,000' },
      { label: 'Second Installment (June)', items: [{ name: 'A', price: '€1,000' }], total: '€1,000' },
    ]
    expect((applyRenewalAmounts(euro, 1100, 1100) as typeof euro)[0].total).toBe('€1,100')
  })

  it('reads a saved text back to a number for the edit form', () => {
    expect(amountFromSavedText('$1,000')).toBe(1000)
    expect(amountFromSavedText('$2.500')).toBe(2500)
    expect(amountFromSavedText(null)).toBeNull()
    expect(amountFromSavedText('see offer')).toBeNull()
  })
})

describe('what a contract is called', () => {
  it('uses the real agreement titles', () => {
    expect(contractLabel('formation', 2025)).toEqual({ chip: 'Formation', title: 'Master Service Agreement, Statement of Work and add-on agreements' })
    expect(contractLabel('onboarding', null).chip).toBe('Onboarding')
    expect(contractLabel('renewal', 2026)).toEqual({ chip: 'Annual renewal', title: 'Annual renewal agreement 2026' })
    expect(contractLabel('tax_return', null).title).toBe('Tax Return Filing Agreement')
    expect(contractLabel('itin', null).title).toBe('ITIN Application Service Agreement')
    expect(contractLabel('closure', null).title).toBe('Company Closure Service Agreement')
    expect(contractLabel('company_change_name', null).title).toBe('Company Name Change Service Agreement')
  })

  it('names an unknown type plainly', () => {
    expect(contractLabel('custom_apostille', null)).toEqual({ chip: 'Apostille', title: 'Service agreement' })
    expect(contractLabel(null, null)).toEqual({ chip: 'Contract', title: 'Service agreement' })
  })

  it('only formation, onboarding and renewal carry installment amounts', () => {
    expect(['formation', 'onboarding', 'renewal'].every(hasInstallmentAmounts)).toBe(true)
    expect(['tax_return', 'itin', 'closure', 'company_change_name', null].some((t) => hasInstallmentAmounts(t))).toBe(false)
  })
})
