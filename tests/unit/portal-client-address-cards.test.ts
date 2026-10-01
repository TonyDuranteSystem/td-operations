import { describe, it, expect } from 'vitest'
import { principalOfficeForClient, mailingForClient, TD_MAILING_ROW } from '@/lib/addresses'

const LARGO_SHARED = { address_line1: '10225 Ulmerton Rd', address_line2: '3D', city: 'Largo', state: 'FL', zip: '33771' }
const WYOMING = { address_line1: '30 N Gould St', address_line2: 'Ste R', city: 'Sheridan', state: 'WY', zip: '82801' }

describe('Principal Office card (client view)', () => {
  it('a company with a suite sees our Largo office + its own suite, nothing else of the saved row', () => {
    const r = principalOfficeForClient({ ...LARGO_SHARED, name: 'TD Office' } as never, null, '3D-433')
    expect(r).toMatchObject({ address_line1: '10225 Ulmerton Rd', address_line2: 'Suite 3D-433', city: 'Largo' })
    expect(JSON.stringify(r)).not.toContain('TD Office')
  })
  it('a company with NO suite whose saved row is the shared Largo row sees "not on file", never a bare "3D" (2026-10-01 QA)', () => {
    expect(principalOfficeForClient(LARGO_SHARED, null, null)).toBeNull()
    expect(principalOfficeForClient(null, LARGO_SHARED, null)).toBeNull()
  })
  it('a company with no suite keeps a real saved Principal Office', () => {
    expect(principalOfficeForClient(WYOMING, null, null)).toEqual(WYOMING)
  })
  it('nothing saved and no suite -> not on file', () => {
    expect(principalOfficeForClient(null, null, null)).toBeNull()
  })
})

describe('Mailing card (client view) — our Seminole mailbox for everyone', () => {
  it('no saved mailing row -> Tony Durante LLC, Seminole (was "not on file" for 236 of 248 active clients)', () => {
    const r = mailingForClient(null)
    expect(r).toBe(TD_MAILING_ROW)
    expect(TD_MAILING_ROW).toMatchObject({ name: 'Tony Durante LLC', address_line1: '11125 Park Blvd', address_line2: 'Suite 104-153', city: 'Seminole', state: 'FL', zip: '33772' })
  })
  it('a client who has their own saved mailing row keeps it', () => {
    expect(mailingForClient(WYOMING)).toEqual(WYOMING)
  })
  it('an empty saved row (no street) counts as nothing saved', () => {
    expect(mailingForClient({ address_line1: '', address_line2: null, city: null, state: null, zip: null } as never)).toBe(TD_MAILING_ROW)
  })
})
