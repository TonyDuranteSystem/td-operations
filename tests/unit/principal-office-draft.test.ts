import { describe, it, expect } from 'vitest'
import { EMPTY_PRINCIPAL_OFFICE_DRAFT, principalOfficeAnswer } from '@/lib/principal-office-draft'

describe('principalOfficeAnswer — the annual-report principal-address question', () => {
  it('is not answered until a choice is made', () => {
    expect(principalOfficeAnswer(EMPTY_PRINCIPAL_OFFICE_DRAFT)).toBeNull()
  })
  it('"unchanged" is a complete answer by itself', () => {
    expect(principalOfficeAnswer({ ...EMPTY_PRINCIPAL_OFFICE_DRAFT, choice: 'unchanged' })).toEqual({ changed: false })
  })
  it('"changed" needs street, city, state and ZIP — line 2 is optional', () => {
    const base = { ...EMPTY_PRINCIPAL_OFFICE_DRAFT, choice: 'changed' as const }
    expect(principalOfficeAnswer(base)).toBeNull()
    expect(principalOfficeAnswer({ ...base, address_line1: '30 N Gould St', city: 'Sheridan', state: 'WY' })).toBeNull() // no ZIP
    expect(principalOfficeAnswer({ ...base, address_line1: '30 N Gould St', city: 'Sheridan', state: 'WY', zip: '82801' })).toEqual({
      changed: true, address_line1: '30 N Gould St', address_line2: '', city: 'Sheridan', state: 'WY', zip: '82801',
    })
  })
  it('trims spaces and treats whitespace-only fields as missing', () => {
    const d = { ...EMPTY_PRINCIPAL_OFFICE_DRAFT, choice: 'changed' as const, address_line1: '  1 Main St ', address_line2: ' Ste 4 ', city: ' Town ', state: ' FL ', zip: ' 33771 ' }
    expect(principalOfficeAnswer(d)).toEqual({ changed: true, address_line1: '1 Main St', address_line2: 'Ste 4', city: 'Town', state: 'FL', zip: '33771' })
    expect(principalOfficeAnswer({ ...d, city: '   ' })).toBeNull()
  })
})
