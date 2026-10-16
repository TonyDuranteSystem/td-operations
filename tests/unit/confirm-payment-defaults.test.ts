import { describe, it, expect } from 'vitest'
import { confirmPaymentCurrency } from '@/lib/offers/confirm-payment-defaults'

describe('confirmPaymentCurrency', () => {
  it('an explicit offer currency wins over the price text (IAA: contract says €450, invoice is USD)', () => {
    expect(confirmPaymentCurrency('USD', [{ total: '€450' }])).toBe('USD')
    expect(confirmPaymentCurrency('EUR', [{ total: '$450' }])).toBe('EUR')
  })

  it('is case/space tolerant on the explicit value', () => {
    expect(confirmPaymentCurrency(' usd ', [{ total: '€450' }])).toBe('USD')
  })

  it('without an explicit currency it reads the price text as before', () => {
    expect(confirmPaymentCurrency(null, [{ total: '$2,300' }])).toBe('USD')
    expect(confirmPaymentCurrency(undefined, [{ total: '€450' }])).toBe('EUR')
    expect(confirmPaymentCurrency('', [{ total: '€450' }, { total: '$100' }])).toBe('USD')
  })

  it('defaults to EUR when there is nothing to read (unchanged legacy default)', () => {
    expect(confirmPaymentCurrency(null, null)).toBe('EUR')
    expect(confirmPaymentCurrency(null, [])).toBe('EUR')
  })

  it('ignores a junk explicit value', () => {
    expect(confirmPaymentCurrency('GBP', [{ total: '$10' }])).toBe('USD')
  })
})
