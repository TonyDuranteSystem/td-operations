import { describe, it, expect } from 'vitest'
import {
  isAmountLocked,
  prepareAmountEdit,
  perYearTotal,
  perYearLabel,
  formatMoney,
  currencySymbol,
  isListAmountField,
} from '@/lib/crm-lists/amounts'

describe('isAmountLocked', () => {
  it.each(['Closed', 'Cancelled', 'Offboarding'])('locks %s', (s) => {
    expect(isAmountLocked(s)).toBe(true)
  })
  it.each(['Active', 'Suspended', 'Pending Formation', null, undefined, ''])('does not lock %s', (s) => {
    expect(isAmountLocked(s as string | null | undefined)).toBe(false)
  })
})

describe('isListAmountField', () => {
  it('accepts only the three amount fields', () => {
    expect(isListAmountField('installment_1_amount')).toBe(true)
    expect(isListAmountField('installment_2_amount')).toBe(true)
    expect(isListAmountField('setup_fee_amount')).toBe(true)
    expect(isListAmountField('installment_1_currency')).toBe(false)
    expect(isListAmountField('status')).toBe(false)
    expect(isListAmountField('company_name')).toBe(false)
  })
})

describe('prepareAmountEdit', () => {
  it('reads a plain number', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '1250', status: 'Active' })).toEqual({ ok: true, value: '1250', amount: 1250 })
  })
  it('reads thousands separators in both styles', () => {
    expect(prepareAmountEdit({ field: 'installment_2_amount', raw: '1,250', status: 'Active' })).toEqual({ ok: true, value: '1250', amount: 1250 })
    expect(prepareAmountEdit({ field: 'installment_2_amount', raw: '1.250', status: 'Active' })).toEqual({ ok: true, value: '1250', amount: 1250 })
  })
  it('reads a currency symbol and cents', () => {
    expect(prepareAmountEdit({ field: 'setup_fee_amount', raw: '$ 1,789.50', status: 'Active' })).toEqual({ ok: true, value: '1789.5', amount: 1789.5 })
  })
  it('an empty box clears the amount', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '', status: 'Active' })).toEqual({ ok: true, value: '', amount: null })
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '   ', status: 'Active' })).toEqual({ ok: true, value: '', amount: null })
  })
  it('refuses a locked company, whatever was typed', () => {
    for (const status of ['Closed', 'Cancelled', 'Offboarding']) {
      const r = prepareAmountEdit({ field: 'installment_1_amount', raw: '1000', status })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(status)
    }
  })
  it('refuses a locked company even when the box is empty (no silent clearing)', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '', status: 'Closed' }).ok).toBe(false)
  })
  it('lets Suspended and Pending Formation companies be edited', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '900', status: 'Suspended' }).ok).toBe(true)
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '900', status: 'Pending Formation' }).ok).toBe(true)
  })
  it('refuses zero, negatives, text and huge numbers', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '0', status: 'Active' }).ok).toBe(false)
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '-5', status: 'Active' }).ok).toBe(false)
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: 'abc', status: 'Active' }).ok).toBe(false)
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '2000000', status: 'Active' }).ok).toBe(false)
  })
  it('refuses a field that is not an amount (currency, status, name)', () => {
    expect(prepareAmountEdit({ field: 'installment_1_currency', raw: 'EUR', status: 'Active' }).ok).toBe(false)
    expect(prepareAmountEdit({ field: 'status', raw: 'Closed', status: 'Active' }).ok).toBe(false)
  })
  it('a missing status is treated as editable (the server reads the real status first)', () => {
    expect(prepareAmountEdit({ field: 'installment_1_amount', raw: '100', status: null }).ok).toBe(true)
  })
})

describe('perYearTotal', () => {
  it('adds the two installments in the same currency', () => {
    expect(perYearTotal({ amount: 1000, currency: 'USD' }, { amount: 1250, currency: 'USD' })).toEqual({ kind: 'one', amount: 2250, currency: 'USD' })
  })
  it('changes with the installment (1,000 -> 1,300)', () => {
    expect(perYearTotal({ amount: 1300, currency: 'USD' }, { amount: 1250, currency: 'USD' })).toEqual({ kind: 'one', amount: 2550, currency: 'USD' })
  })
  it('treats a missing currency as USD', () => {
    expect(perYearTotal({ amount: 500, currency: null }, { amount: 500, currency: 'USD' })).toEqual({ kind: 'one', amount: 1000, currency: 'USD' })
  })
  it('does not add across currencies', () => {
    const r = perYearTotal({ amount: 1000, currency: 'USD' }, { amount: 900, currency: 'EUR' })
    expect(r).toEqual({ kind: 'split', parts: [{ amount: 1000, currency: 'USD' }, { amount: 900, currency: 'EUR' }] })
    expect(perYearLabel(r)).toBe('$1,000 + €900')
  })
  it('uses the one installment that exists', () => {
    expect(perYearTotal({ amount: 1000, currency: 'USD' }, { amount: null, currency: 'USD' })).toEqual({ kind: 'one', amount: 1000, currency: 'USD' })
  })
  it('is none when neither exists', () => {
    expect(perYearTotal({ amount: null, currency: null }, { amount: null, currency: null })).toEqual({ kind: 'none' })
    expect(perYearLabel({ kind: 'none' })).toBe('—')
  })
  it('avoids floating-point noise', () => {
    expect(perYearTotal({ amount: 0.1, currency: 'USD' }, { amount: 0.2, currency: 'USD' })).toEqual({ kind: 'one', amount: 0.3, currency: 'USD' })
  })
})

describe('money formatting', () => {
  it('uses the right symbol', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol(null)).toBe('$')
    expect(currencySymbol('GBP')).toBe('')
  })
  it('formats with thousands separators', () => {
    expect(formatMoney(1250, 'USD')).toBe('$1,250')
    expect(formatMoney(1789.5, 'EUR')).toBe('€1,789.50')
  })
})
