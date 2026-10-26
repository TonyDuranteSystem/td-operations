import { describe, it, expect } from 'vitest'
import { isNoChargeFee } from '@/lib/offers/fee-label'

describe('isNoChargeFee', () => {
  it('free and included fees (the money engine\'s own rules plus plain "free")', () => {
    for (const f of ['$0', '€0.00', '0', 'USD 0', 'Included', 'included in the offer', ' INCLUDED ', '$300 inclusa', 'Free', 'gratis', 'Gift', 'No charge']) expect(isNoChargeFee(f), f).toBe(true)
  })
  it('paid fees, recurring prices and empty values are not "no charge"', () => {
    for (const f of ['$80', '€1,200', '$0.50', '100', '$0/year', '$0/month', '', '   ', null, undefined]) expect(isNoChargeFee(f as never), String(f)).toBe(false)
  })
})
