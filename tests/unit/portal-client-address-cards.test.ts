import { describe, it, expect } from 'vitest'
import { principalOfficeForClient, mailingForClient, shippingForClient, TD_SHIPPING_ROW, formatAddressString } from '@/lib/addresses'

const LARGO_SHARED = { address_line1: '10225 Ulmerton Rd', address_line2: '3D', city: 'Largo', state: 'FL', zip: '33771' }
const WYOMING = { address_line1: '30 N Gould St', address_line2: 'Ste R', city: 'Sheridan', state: 'WY', zip: '82801' }

describe('Principal Office card (client view) — the OFFICIAL address', () => {
  it('a company with a number sees 10225 Ulmerton Rd 3D, Largo — the same for every client, no company number, nothing of the saved row', () => {
    const r = principalOfficeForClient({ ...LARGO_SHARED, name: 'TD Office' } as never, null, '3D-433')
    expect(r).toMatchObject({ address_line1: '10225 Ulmerton Rd 3D', address_line2: null, city: 'Largo', state: 'FL', zip: '33771' })
    expect(JSON.stringify(r)).not.toContain('TD Office')
    expect(JSON.stringify(r)).not.toContain('433')
    expect(principalOfficeForClient(null, null, '3D-205')).toEqual(r)
  })
  it('a company with NO number whose saved row is the shared Largo row sees "not on file" (Largo is not its address)', () => {
    expect(principalOfficeForClient(LARGO_SHARED, null, null)).toBeNull()
    expect(principalOfficeForClient(null, LARGO_SHARED, null)).toBeNull()
  })
  it('a company with no number keeps a real saved Principal Office', () => {
    expect(principalOfficeForClient(WYOMING, null, null)).toEqual(WYOMING)
  })
  it('nothing saved and no number -> not on file', () => {
    expect(principalOfficeForClient(null, null, null)).toBeNull()
  })
})

describe('Mailing card (client view) — official address + the company\'s own PMB', () => {
  it('prints "10225 Ulmerton Rd 3D PMB 318, Largo" for company 3D-318, and a different PMB for another company', () => {
    expect(formatAddressString(mailingForClient('3D-318'))).toBe('10225 Ulmerton Rd 3D PMB 318, Largo FL 33771')
    expect(formatAddressString(mailingForClient('3D-205'))).toBe('10225 Ulmerton Rd 3D PMB 205, Largo FL 33771')
  })
  it('is "not on file" until a number is issued', () => {
    expect(mailingForClient(null)).toBeNull()
  })
})

describe('Shipping card (client view) — our Seminole office for everyone', () => {
  it('is Tony Durante LLC, Seminole — the same for every client', () => {
    expect(shippingForClient()).toBe(TD_SHIPPING_ROW)
    expect(TD_SHIPPING_ROW).toMatchObject({ name: 'Tony Durante LLC', address_line1: '11125 Park Blvd', address_line2: 'Suite 104-153', city: 'Seminole', state: 'FL', zip: '33772' })
  })
})

describe('Principal Office picks the first usable saved row', () => {
  it('a shared-Largo legal row does not hide a real saved mailing row', () => {
    expect(principalOfficeForClient(LARGO_SHARED, WYOMING, null)).toEqual(WYOMING)
  })
})
