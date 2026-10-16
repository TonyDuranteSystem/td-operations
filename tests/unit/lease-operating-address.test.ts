import { describe, it, expect } from 'vitest'
import { contactOperatingAddress } from '@/lib/lease/operating-address'
import { buildAgreementV2 } from '@/lib/lease/agreement-v2'

/**
 * The Operating Address (Section 1.1) comes from the signer's CRM contact and prints as an address block like the other
 * addresses (Antonio 2026-10-14); a one-line typed address stays an inline sentence; no address yet -> "the address Client enters".
 */
const INPUT = { providerName: 'Tony Durante LLC', clientCompany: 'Acme LLC', clientState: 'Wyoming', clientEin: null, clientRepName: 'Jane Rossi', clientRepTitle: 'Manager', suiteNumber: '3D-318', exhibitPhotos: [] }
const text = (doc: ReturnType<typeof buildAgreementV2>) => doc.blocks.map(b => ('text' in b ? b.text : 'lines' in b ? b.lines.join(' | ') : '')).join('\n')

describe('contactOperatingAddress', () => {
  it('an Italian contact: street / "ZIP city, province" / country', () => {
    expect(contactOperatingAddress({ address_line1: 'Via Roma 1', address_city: 'Milano', address_state: 'MI', address_zip: '20121', address_country: 'Italy' }))
      .toEqual({ lines: ['Via Roma 1', '20121 Milano, MI', 'Italy'], text: 'Via Roma 1\n20121 Milano, MI\nItaly' })
  })

  it('a US contact: "City, ST ZIP"', () => {
    expect(contactOperatingAddress({ address_line1: '1234 Brickell Ave', address_city: 'Miami', address_state: 'FL', address_zip: '33131', address_country: 'United States' })?.lines)
      .toEqual(['1234 Brickell Ave', 'Miami, FL 33131', 'United States'])
  })

  it('needs a street AND a city or country; blanks and control characters are cleaned; nothing -> null', () => {
    expect(contactOperatingAddress(null)).toBeNull()
    expect(contactOperatingAddress({})).toBeNull()
    expect(contactOperatingAddress({ address_line1: 'Via Roma 1' })).toBeNull() // a bare street is not an address
    expect(contactOperatingAddress({ address_city: 'Milano', address_country: 'Italy' })).toBeNull() // no street
    expect(contactOperatingAddress({ address_line1: '  Via  Roma\n1 ', address_city: ' Milano ', address_country: '' })?.lines).toEqual(['Via Roma 1', 'Milano'])
  })
})

describe('Section 1.1 in the agreement', () => {
  it('a CRM address (several lines) prints as an address block under the company name, like Section 1.2', () => {
    const doc = buildAgreementV2({ ...INPUT, operatingAddress: 'Via Roma 1\n20121 Milano, MI\nItaly' })
    const blocks = doc.blocks.filter(b => b.t === 'address') as { lines: string[] }[]
    expect(blocks).toHaveLength(3) // Section 1.1 operating address, then 1.2 official and mailing
    expect(blocks[0].lines).toEqual(['Acme LLC', 'Via Roma 1', '20121 Milano, MI', 'Italy'])
    expect(blocks[1].lines).toEqual(['Acme LLC', '10225 Ulmerton Rd 3D', 'Largo, FL 33771'])
    expect(blocks[2].lines.join(' ')).toContain('PMB 318')
    expect(text(doc)).toContain('are run from the address below (the "Operating Address")')
    expect(text(doc)).not.toContain('Via Roma 1, 20121')
  })

  it('a one-line typed address stays an inline sentence; none yet -> the placeholder', () => {
    expect(text(buildAgreementV2({ ...INPUT, operatingAddress: 'Via Roma 1, Milano, Italy' }))).toContain('are run from Via Roma 1, Milano, Italy (the "Operating Address")')
    expect(text(buildAgreementV2({ ...INPUT, operatingAddress: null }))).toContain('the address Client enters when signing')
  })
})
