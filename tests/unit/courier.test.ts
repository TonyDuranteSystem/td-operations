import { describe, it, expect } from 'vitest'
import { COURIERS, isCourier, courierTrackingUrl } from '@/lib/flows/courier'

describe('isCourier', () => {
  it('accepts known couriers', () => {
    for (const c of COURIERS) expect(isCourier(c)).toBe(true)
  })
  it('rejects unknown / empty values', () => {
    expect(isCourier('Royal Mail')).toBe(false)
    expect(isCourier('')).toBe(false)
    expect(isCourier(null)).toBe(false)
    expect(isCourier(undefined)).toBe(false)
  })
})

describe('courierTrackingUrl', () => {
  it('builds the right URL per courier', () => {
    expect(courierTrackingUrl('FedEx', '123')).toBe('https://www.fedex.com/fedextrack/?trknbr=123')
    expect(courierTrackingUrl('UPS', '123')).toBe('https://www.ups.com/track?loc=en_US&tracknum=123')
    expect(courierTrackingUrl('DHL', '123')).toBe('https://www.dhl.com/global-en/home/tracking.html?tracking-id=123')
    expect(courierTrackingUrl('USPS', '123')).toBe('https://tools.usps.com/go/TrackConfirmAction?tLabels=123')
  })

  it('URL-encodes the tracking number and trims whitespace', () => {
    expect(courierTrackingUrl('FedEx', '  AB 12/34 ')).toBe('https://www.fedex.com/fedextrack/?trknbr=AB%2012%2F34')
  })

  it('returns null for Other, unknown courier, or empty/whitespace tracking', () => {
    expect(courierTrackingUrl('Other', '123')).toBeNull()
    expect(courierTrackingUrl('Royal Mail', '123')).toBeNull()
    expect(courierTrackingUrl('FedEx', '')).toBeNull()
    expect(courierTrackingUrl('FedEx', '   ')).toBeNull()
    expect(courierTrackingUrl(null, '123')).toBeNull()
    expect(courierTrackingUrl('FedEx', null)).toBeNull()
  })
})
