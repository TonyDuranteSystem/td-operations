/**
 * Resolve a client's IANA timezone from their stored country
 * (`contacts.address_country`), for the portal "YOUR TIME" clock.
 *
 * Why country-based: the portal clock must show the CLIENT's own timezone even
 * when staff open the client's portal (View-as), where the browser timezone is
 * the staff member's, not the client's. The logged-in/viewed contact's country
 * is the reliable signal.
 *
 * Returns null when the country is empty or unrecognised — the caller then falls
 * back to the device/browser timezone (Antonio's choice for the ~empty bucket).
 *
 * Country data is free-text and inconsistent ("Italy"/"Italia"/casing), so input
 * is normalised (trim, lowercase, strip accents/punctuation) before lookup, with
 * an alias table for common spellings.
 *
 * Multi-timezone countries (US, Canada, Australia, Brazil, Mexico, …) map to their
 * MAIN timezone for now; refine by state/city later if needed.
 */

export interface ClientTimeZone {
  /** IANA timezone, e.g. "Europe/Rome". */
  tz: string
  /** Friendly label shown under the clock, e.g. "Italy". */
  label: string
}

function normalizeCountry(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
}

// Canonical normalized-country → timezone + label.
const COUNTRY_TZ: Record<string, ClientTimeZone> = {
  // — seen in the data —
  italy: { tz: 'Europe/Rome', label: 'Italy' },
  portugal: { tz: 'Europe/Lisbon', label: 'Portugal' },
  'united arab emirates': { tz: 'Asia/Dubai', label: 'UAE' },
  malta: { tz: 'Europe/Malta', label: 'Malta' },
  hungary: { tz: 'Europe/Budapest', label: 'Hungary' },
  spain: { tz: 'Europe/Madrid', label: 'Spain' },
  albania: { tz: 'Europe/Tirane', label: 'Albania' },
  thailand: { tz: 'Asia/Bangkok', label: 'Thailand' },
  paraguay: { tz: 'America/Asuncion', label: 'Paraguay' },
  slovakia: { tz: 'Europe/Bratislava', label: 'Slovakia' },
  'united kingdom': { tz: 'Europe/London', label: 'United Kingdom' },
  romania: { tz: 'Europe/Bucharest', label: 'Romania' },
  bulgaria: { tz: 'Europe/Sofia', label: 'Bulgaria' },
  france: { tz: 'Europe/Paris', label: 'France' },
  mexico: { tz: 'America/Mexico_City', label: 'Mexico' }, // multi-tz → main
  denmark: { tz: 'Europe/Copenhagen', label: 'Denmark' },
  philippines: { tz: 'Asia/Manila', label: 'Philippines' },
  // — common others —
  germany: { tz: 'Europe/Berlin', label: 'Germany' },
  netherlands: { tz: 'Europe/Amsterdam', label: 'Netherlands' },
  switzerland: { tz: 'Europe/Zurich', label: 'Switzerland' },
  poland: { tz: 'Europe/Warsaw', label: 'Poland' },
  greece: { tz: 'Europe/Athens', label: 'Greece' },
  austria: { tz: 'Europe/Vienna', label: 'Austria' },
  belgium: { tz: 'Europe/Brussels', label: 'Belgium' },
  ireland: { tz: 'Europe/Dublin', label: 'Ireland' },
  'czech republic': { tz: 'Europe/Prague', label: 'Czech Republic' },
  croatia: { tz: 'Europe/Zagreb', label: 'Croatia' },
  slovenia: { tz: 'Europe/Ljubljana', label: 'Slovenia' },
  serbia: { tz: 'Europe/Belgrade', label: 'Serbia' },
  sweden: { tz: 'Europe/Stockholm', label: 'Sweden' },
  norway: { tz: 'Europe/Oslo', label: 'Norway' },
  finland: { tz: 'Europe/Helsinki', label: 'Finland' },
  turkey: { tz: 'Europe/Istanbul', label: 'Türkiye' },
  luxembourg: { tz: 'Europe/Luxembourg', label: 'Luxembourg' },
  cyprus: { tz: 'Asia/Nicosia', label: 'Cyprus' },
  ukraine: { tz: 'Europe/Kyiv', label: 'Ukraine' },
  estonia: { tz: 'Europe/Tallinn', label: 'Estonia' },
  latvia: { tz: 'Europe/Riga', label: 'Latvia' },
  lithuania: { tz: 'Europe/Vilnius', label: 'Lithuania' },
  israel: { tz: 'Asia/Jerusalem', label: 'Israel' },
  'saudi arabia': { tz: 'Asia/Riyadh', label: 'Saudi Arabia' },
  qatar: { tz: 'Asia/Qatar', label: 'Qatar' },
  india: { tz: 'Asia/Kolkata', label: 'India' },
  singapore: { tz: 'Asia/Singapore', label: 'Singapore' },
  'hong kong': { tz: 'Asia/Hong_Kong', label: 'Hong Kong' },
  japan: { tz: 'Asia/Tokyo', label: 'Japan' },
  china: { tz: 'Asia/Shanghai', label: 'China' },
  vietnam: { tz: 'Asia/Ho_Chi_Minh', label: 'Vietnam' },
  malaysia: { tz: 'Asia/Kuala_Lumpur', label: 'Malaysia' },
  indonesia: { tz: 'Asia/Jakarta', label: 'Indonesia' }, // multi-tz → main
  morocco: { tz: 'Africa/Casablanca', label: 'Morocco' },
  egypt: { tz: 'Africa/Cairo', label: 'Egypt' },
  nigeria: { tz: 'Africa/Lagos', label: 'Nigeria' },
  'south africa': { tz: 'Africa/Johannesburg', label: 'South Africa' },
  brazil: { tz: 'America/Sao_Paulo', label: 'Brazil' }, // multi-tz → main
  argentina: { tz: 'America/Argentina/Buenos_Aires', label: 'Argentina' },
  colombia: { tz: 'America/Bogota', label: 'Colombia' },
  chile: { tz: 'America/Santiago', label: 'Chile' },
  peru: { tz: 'America/Lima', label: 'Peru' },
  canada: { tz: 'America/Toronto', label: 'Canada' }, // multi-tz → main
  'united states': { tz: 'America/New_York', label: 'United States' }, // multi-tz → main
  australia: { tz: 'Australia/Sydney', label: 'Australia' }, // multi-tz → main
  'new zealand': { tz: 'Pacific/Auckland', label: 'New Zealand' },
}

// Alternate spellings / native names / abbreviations → canonical key above.
const ALIASES: Record<string, string> = {
  italia: 'italy',
  uae: 'united arab emirates',
  'u a e': 'united arab emirates',
  emirates: 'united arab emirates',
  espana: 'spain',
  spagna: 'spain',
  uk: 'united kingdom',
  'u k': 'united kingdom',
  england: 'united kingdom',
  'great britain': 'united kingdom',
  britain: 'united kingdom',
  gb: 'united kingdom',
  deutschland: 'germany',
  germania: 'germany',
  holland: 'netherlands',
  'the netherlands': 'netherlands',
  svizzera: 'switzerland',
  suisse: 'switzerland',
  brasil: 'brazil',
  turkiye: 'turkey',
  czechia: 'czech republic',
  czech: 'czech republic',
  usa: 'united states',
  us: 'united states',
  'u s a': 'united states',
  'u s': 'united states',
  'united states of america': 'united states',
  america: 'united states',
  portogallo: 'portugal',
  francia: 'france',
  grecia: 'greece',
  messico: 'mexico',
  ungheria: 'hungary',
  romania_it: 'romania',
}

/**
 * Map a free-text country to a timezone + label, or null if unknown/empty.
 */
export function countryToTimeZone(country: string | null | undefined): ClientTimeZone | null {
  const key = normalizeCountry(country)
  if (!key) return null
  const aliased = ALIASES[key] ?? key
  return COUNTRY_TZ[aliased] ?? null
}
