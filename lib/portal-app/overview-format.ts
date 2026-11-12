// Client iPhone app, Overview redesign (dev job 056a70d0): the small text helpers the app's Overview cards use. Pure.

/** The two letters in the round picture of the profile header: first letter of the first and last name, else of the e-mail, else a dot. */
export function initialsFor(first: string | null | undefined, last: string | null | undefined, email?: string | null): string {
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  const letters = `${Array.from(f)[0] ?? ''}${Array.from(l)[0] ?? ''}`
  if (letters) return letters.toUpperCase()
  const e = (email ?? '').trim()
  return e ? Array.from(e)[0].toUpperCase() : '•'
}

export interface ProfileAddressFields {
  address_line1?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
}

const trim = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '')

/**
 * The person's own address as ONE block of up to three lines (street / city, state zip / country) instead of five separate rows that were
 * mostly dashes. Empty when nothing is filled in.
 */
export function profileAddressLines(a: ProfileAddressFields): string[] {
  const stateZip = [trim(a.address_state), trim(a.address_zip)].filter(Boolean).join(' ')
  const cityLine = [trim(a.address_city), stateZip].filter(Boolean).join(', ')
  return [trim(a.address_line1), cityLine, trim(a.address_country)].filter(Boolean)
}

export interface CompanyAddressParts {
  address_line1: string | null
  address_line2?: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface AddressRow {
  key: 'address' | 'suite' | 'city' | 'state' | 'zip'
  label: string
  value: string
}

export interface AddressLabels {
  address: string
  suite: string
  city: string
  state: string
  zip: string
}

/**
 * The labelled lines of one company address, exactly as the website's card chooses them: the five labelled lines when the address has all of
 * street, city, state and zip (suite only when there is one); otherwise the single old free-text line; otherwise nothing ("not on file").
 */
export function addressView(
  parts: CompanyAddressParts | null | undefined,
  legacy: string | null | undefined,
  labels: AddressLabels,
): { rows: AddressRow[]; legacy: string | null; copyText: string | null } {
  const structured = !!(trim(parts?.address_line1) && trim(parts?.city) && trim(parts?.state) && trim(parts?.zip))
  if (structured && parts) {
    const rows: AddressRow[] = [{ key: 'address', label: labels.address, value: trim(parts.address_line1) }]
    if (trim(parts.address_line2)) rows.push({ key: 'suite', label: labels.suite, value: trim(parts.address_line2) })
    rows.push(
      { key: 'city', label: labels.city, value: trim(parts.city) },
      { key: 'state', label: labels.state, value: trim(parts.state) },
      { key: 'zip', label: labels.zip, value: trim(parts.zip) },
    )
    // What is copied is how the address is written on an envelope, not the labelled list.
    const copyText = [trim(parts.address_line1), trim(parts.address_line2), `${trim(parts.city)}, ${trim(parts.state)} ${trim(parts.zip)}`].filter(Boolean).join('\n')
    return { rows, legacy: null, copyText }
  }
  const old = trim(legacy)
  if (old) return { rows: [], legacy: old, copyText: old }
  return { rows: [], legacy: null, copyText: null }
}
