/**
 * The Operating Address of the Office Lease and Services Agreement (Section 1.1) — "where the Client's day-to-day business
 * operations are run" — comes from the CRM contact who signs the lease (Antonio 2026-10-14: "the lease must keep this address
 * from the CRM in contact"). The client no longer types it when the CRM has it; they only read it. When the CRM has no usable
 * address the signing page falls back to the old text box.
 *
 * The address is stored on the lease (operating_address) as lines joined by "\n" — a multi-line value is printed as an address
 * block like the other addresses in Section 1.2; a one-line value (typed by the client) stays an inline sentence.
 */
export interface ContactAddressParts {
  address_line1?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
}

export interface OperatingAddress {
  lines: string[]
  /** The lines joined by "\n" — what is stored on the lease and compared at signing. */
  text: string
}

export const CONTACT_ADDRESS_COLUMNS = 'address_line1, address_city, address_state, address_zip, address_country'

const clean = (v: string | null | undefined): string => (v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
const isUs = (country: string): boolean => /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(country)

/**
 * Street + a city line + country. Needs a street AND at least a city or a country — a bare street is not an address a reader
 * can place, so it counts as "no address" (the client then types one). Returns null when the contact has none.
 */
export function contactOperatingAddress(contact: ContactAddressParts | null | undefined): OperatingAddress | null {
  if (!contact) return null
  const line1 = clean(contact.address_line1)
  const city = clean(contact.address_city)
  const state = clean(contact.address_state)
  const zip = clean(contact.address_zip)
  const country = clean(contact.address_country)
  if (!line1 || !(city || country)) return null

  const cityLine = isUs(country)
    ? [[city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ') // "Miami, FL 33131"
    : [[zip, city].filter(Boolean).join(' '), state].filter(Boolean).join(', ') // "20121 Milano, MI"
  const lines = [line1, cityLine, country].filter(Boolean)
  return { lines, text: lines.join('\n') }
}
