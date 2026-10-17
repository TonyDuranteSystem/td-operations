/**
 * The one-line address that is stored for a customer and printed on invoices / PDFs:
 * "Street, 20100 Milano, Region, Country". The postal code goes in front of the city (the Italian way, and fine for US/UK too).
 */
export function formatCustomerAddress(parts: {
  street?: string | null
  postalCode?: string | null
  city?: string | null
  region?: string | null
  country?: string | null
}): string {
  const clean = (v?: string | null) => (v ?? '').trim()
  const cityLine = [clean(parts.postalCode), clean(parts.city)].filter(Boolean).join(' ')
  return [clean(parts.street), cityLine, clean(parts.region), clean(parts.country)].filter(Boolean).join(', ')
}

/**
 * The address to SHOW for a stored customer. New customers store the full line in `address` (see formatCustomerAddress);
 * older ones, and any customer whose postal code / city was edited afterwards, keep those parts only in their own columns.
 * Parts already inside the address text are not repeated; missing ones are added after it.
 */
export function displayCustomerAddress(c: {
  address?: string | null
  postal_code?: string | null
  city?: string | null
  region?: string | null
  country?: string | null
}): string {
  const base = (c.address ?? '').trim()
  const has = (piece: string) => base.toLowerCase().includes(piece.toLowerCase())
  const postal = (c.postal_code ?? '').trim()
  const city = (c.city ?? '').trim()
  const region = (c.region ?? '').trim()
  const country = (c.country ?? '').trim()
  const missing: string[] = []
  const postalMissing = !!postal && !has(postal)
  const cityMissing = !!city && !has(city)
  if (postalMissing && cityMissing) missing.push(`${postal} ${city}`)
  else if (postalMissing) missing.push(postal)
  else if (cityMissing) missing.push(city)
  if (region && !has(region)) missing.push(region)
  if (country && !has(country)) missing.push(country)
  return [base, ...missing].filter(Boolean).join(', ')
}
