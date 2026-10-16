import { describe, it, expect } from 'vitest'
import { formatCustomerAddress, displayCustomerAddress } from '@/lib/portal/customer-address'
import { cleanMoneyText, moneyTextToNumber, moneyNumberToText } from '@/lib/portal/money-input'

describe('customer address with a postal code', () => {
  it('puts the postal code in front of the city', () => {
    expect(formatCustomerAddress({ street: 'Via Roma 1', postalCode: '20121', city: 'Milano', region: 'MI', country: 'Italy' }))
      .toBe('Via Roma 1, 20121 Milano, MI, Italy')
  })
  it('skips empty parts and spaces', () => {
    expect(formatCustomerAddress({ street: ' ', postalCode: '', city: 'Milano', region: null, country: undefined })).toBe('Milano')
    expect(formatCustomerAddress({ postalCode: '10001' })).toBe('10001')
  })
  it('shows parts that are only in their own columns, without repeating ones already in the address', () => {
    expect(displayCustomerAddress({ address: 'Via Roma 1, Milano, MI, Italy', postal_code: '20121', city: 'Milano', region: 'MI', country: 'Italy' }))
      .toBe('Via Roma 1, Milano, MI, Italy, 20121')
    expect(displayCustomerAddress({ address: 'Via Roma 1', postal_code: '20121', city: 'Milano', country: 'Italy' }))
      .toBe('Via Roma 1, 20121 Milano, Italy')
    expect(displayCustomerAddress({ address: 'Via Roma 1, 20121 Milano, Italy', postal_code: '20121', city: 'milano', country: 'ITALY' }))
      .toBe('Via Roma 1, 20121 Milano, Italy')
  })
  it('an old customer with nothing extra is unchanged', () => {
    expect(displayCustomerAddress({ address: '1 Main St, Miami' })).toBe('1 Main St, Miami')
    expect(displayCustomerAddress({})).toBe('')
  })
})

describe('price / discount box text', () => {
  it('starts empty for zero and keeps typed digits without a leading zero', () => {
    expect(moneyNumberToText(0)).toBe('')
    expect(moneyNumberToText(15)).toBe('15')
    expect(moneyTextToNumber(cleanMoneyText('15') as string)).toBe(15)
  })
  it('lets a decimal be typed step by step', () => {
    expect(cleanMoneyText('0')).toBe('0')
    expect(cleanMoneyText('0.')).toBe('0.')
    expect(cleanMoneyText('0.5')).toBe('0.5')
    expect(moneyTextToNumber('0.')).toBe(0)
    expect(moneyTextToNumber('0.5')).toBe(0.5)
  })
  it('accepts a comma as a decimal point and rejects letters or two dots', () => {
    expect(cleanMoneyText('12,5')).toBe('12.5')
    expect(cleanMoneyText('1a')).toBeNull()
    expect(cleanMoneyText('1.2.3')).toBeNull()
    expect(cleanMoneyText('-5')).toBeNull()
  })
  it('empty or a lone dot is zero', () => {
    expect(moneyTextToNumber('')).toBe(0)
    expect(moneyTextToNumber('.')).toBe(0)
  })
})
