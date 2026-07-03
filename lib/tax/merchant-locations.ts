/**
 * Deterministic spend-location inference (Smart Categorization v2, Phase 2b —
 * location-period triage). NO AI in v1 — dual-review decision: text parsing +
 * a frozen merchant map cover the flagship cases with zero risk to the gated
 * categorization quality. The AI `country` field is a later rev, only if
 * measured coverage on 2–3 real workspaces proves insufficient.
 *
 * loc_code vocabulary: ISO-3166 alpha-2 country codes plus the region token
 * 'EU' ('EU' is ISO-3166-1 *exceptionally reserved* — it can never collide
 * with a real country). A unit test pins every map value to this vocabulary.
 *
 * MERCHANT MAP INCLUSION RULE (architect cond. 9 — do not weaken):
 * only merchants that are GEO-EXCLUSIVE BY OPERATION — the merchant's spend
 * location is knowable from the brand alone (Talabat delivers in MENA/AE,
 * Glovo delivers in Europe, Trenitalia runs Italian trains). NEVER global or
 * online merchants (Shopify, PayPal, Fiverr — a subscription has no presence
 * location). Per-client local merchants (a single restaurant, a local shop)
 * are deliberately NOT mapped — that's Review-one-by-one + auto-learn
 * territory. The map encodes SPEND location, not the buyer's location: a
 * Talabat order gifted to a Dubai relative while the owner is in Italy is
 * still AE spend — correct as-is; presence inference is the fallible step and
 * is bounded by the detector's density floor. Owner: staff via PR; every
 * entry is pinned by tests/unit/merchant-locations.test.ts.
 */

export const REGION_TOKENS = ["EU"] as const

/** EU membership for the residence filter: if the client's fiscal residence is
 *  one of these, region-level 'EU' periods are indistinguishable from home
 *  spend and are suppressed. */
export const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
])

export interface LocationHit {
  loc_code: string
  loc_source: "text" | "map"
  loc_confidence: "high" | "medium"
}

/** Frozen merchant → spend-location map. Contains-match, lowercase. */
export const MERCHANT_LOCATION_MAP: ReadonlyArray<{ pattern: string; loc: string; confidence: "high" | "medium" }> = [
  { pattern: "glovo", loc: "EU", confidence: "medium" },       // EU-only delivery (ES/IT/PT/…)
  { pattern: "talabat", loc: "AE", confidence: "high" },       // MENA delivery; observed use = Dubai
  { pattern: "careem", loc: "AE", confidence: "high" },        // MENA ride-hailing
  { pattern: "cars taxi", loc: "AE", confidence: "high" },     // Dubai's Cars Taxi Services
  { pattern: "trenitalia", loc: "IT", confidence: "high" },    // Italian rail
  { pattern: "esselunga", loc: "IT", confidence: "high" },     // Italian supermarket chain
  { pattern: "mercadona", loc: "ES", confidence: "high" },     // Spanish supermarket chain
  { pattern: "eroski", loc: "ES", confidence: "high" },        // Spanish supermarket chain
]

/** Curated city → country gazetteer for statement text (Chase prints the city
 *  before "Card NNNN"). UNAMBIGUOUS names only — anything that exists in two
 *  countries a nomad plausibly visits (Perth, Valencia…) stays out: the
 *  extractor NEVER guesses (architect cond. 8). Multi-word first. */
const CITY_GAZETTEER: ReadonlyArray<{ city: string; loc: string }> = [
  { city: "abu dhabi", loc: "AE" },
  { city: "dubai", loc: "AE" },
  { city: "lisboa", loc: "PT" },
  { city: "lisbon", loc: "PT" },
  { city: "porto", loc: "PT" },
  { city: "milano", loc: "IT" },
  { city: "roma", loc: "IT" },
  { city: "firenze", loc: "IT" },
  { city: "napoli", loc: "IT" },
  { city: "bologna", loc: "IT" },
  { city: "torino", loc: "IT" },
  { city: "barcelona", loc: "ES" },
  { city: "madrid", loc: "ES" },
  { city: "sevilla", loc: "ES" },
  { city: "malaga", loc: "ES" },
  { city: "palma de mallorca", loc: "ES" },
  { city: "paris", loc: "FR" },
  { city: "london", loc: "GB" },
  { city: "amsterdam", loc: "NL" },
  { city: "berlin", loc: "DE" },
  { city: "munchen", loc: "DE" },
  { city: "wien", loc: "AT" },
  { city: "zurich", loc: "CH" },
  { city: "geneva", loc: "CH" },
  { city: "istanbul", loc: "TR" },
  { city: "bangkok", loc: "TH" },
  { city: "tbilisi", loc: "GE" },
]

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
])

/** ATM / cash withdrawals are NEVER located (and therefore never presence
 *  spend, never swept): they print strong city text but booking them as
 *  business expense under "All business" would be flatly wrong — they're
 *  draws/transfers (engineer cond. re: ATM named test). */
const ATM_PATTERN = /\batm\b|\bwithdraw|\bcash\s+advance\b|prelievo/i

/** Chase card-purchase suffix: "… <city tokens> <ST> Card 5790" (US) or
 *  "… <city tokens> Card 5790" (foreign). The location sits mid-string just
 *  before "Card NNNN" — respecced from real prod strings (architect cond. 8):
 *  "Card Purchase 01/21 Sq *Joffrey?S Coffee An Tampa FL Card 5782" → US
 *  "… Farmacia Exposul Lisboa Card 5790"                            → PT
 *  Truncated/unknown city tokens ("Setu", "Vila Nova De") → null, never guess. */
function extractChaseCardLocation(description: string): LocationHit | null {
  const m = description.match(/(.{4,}?)\s+card\s+\d{4}\b/i)
  if (!m) return null
  const before = m[1].trim()
  // US format: 2-letter state code as the last token before "Card NNNN".
  const stateMatch = before.match(/\b([A-Z]{2})$/)
  if (stateMatch && US_STATE_CODES.has(stateMatch[1])) {
    return { loc_code: "US", loc_source: "text", loc_confidence: "high" }
  }
  // Foreign format: gazetteer city as the trailing token(s).
  const lower = before.toLowerCase()
  for (const { city, loc } of CITY_GAZETTEER) {
    if (lower.endsWith(city)) return { loc_code: loc, loc_source: "text", loc_confidence: "high" }
  }
  return null
}

/** Explicit country tokens in the text itself, outside the card suffix —
 *  Chase FX lines name the currency's country ("… AE Dirham 29.00 X 0.27 …"). */
function extractExplicitCountryToken(description: string): LocationHit | null {
  if (/\bAE\s+Dirham\b/i.test(description)) return { loc_code: "AE", loc_source: "text", loc_confidence: "high" }
  const lower = description.toLowerCase()
  // A gazetteer city appearing as a standalone word ("talabat pro Dubai 10/31 …").
  for (const { city, loc } of CITY_GAZETTEER) {
    if (new RegExp(`\\b${city.replace(/ /g, "\\s+")}\\b`).test(lower)) {
      return { loc_code: loc, loc_source: "text", loc_confidence: "high" }
    }
  }
  return null
}

function merchantMapLocation(description: string, counterparty: string | null): LocationHit | null {
  const hay = `${description} ${counterparty ?? ""}`.toLowerCase()
  for (const { pattern, loc, confidence } of MERCHANT_LOCATION_MAP) {
    if (hay.includes(pattern)) return { loc_code: loc, loc_source: "map", loc_confidence: confidence }
  }
  return null
}

/**
 * Deterministic location for one transaction, or null (never guesses).
 * Text beats map (a city printed on the statement outranks brand inference).
 * Only OUTFLOWS are located — an inflow has no spend location — and internal
 * transfers/conversions are never located.
 */
export function inferLocation(row: {
  description: string | null
  counterparty: string | null
  amount: number
  category?: string | null
}): LocationHit | null {
  if (!(row.amount < 0)) return null
  if ((row.category ?? "") === "conversion") return null
  const desc = row.description ?? ""
  if (!desc && !row.counterparty) return null
  if (ATM_PATTERN.test(desc)) return null
  return (
    extractChaseCardLocation(desc) ??
    extractExplicitCountryToken(desc) ??
    merchantMapLocation(desc, row.counterparty)
  )
}

/** CRM residence country (free text, client-declared) → ISO code. The anchor
 *  of the whole feature (Antonio, 2026-07-03): spend in the FISCAL-residence
 *  country never gets a period card. Unmapped/missing → null: the UI shows
 *  every detected period plus a "no fiscal residence on file" note. */
const COUNTRY_NAME_TO_ISO: ReadonlyArray<{ names: string[]; loc: string }> = [
  { names: ["united arab emirates", "uae", "emirates"], loc: "AE" },
  { names: ["italy", "italia"], loc: "IT" },
  { names: ["spain", "espana", "españa"], loc: "ES" },
  { names: ["portugal"], loc: "PT" },
  { names: ["france"], loc: "FR" },
  { names: ["germany", "deutschland"], loc: "DE" },
  { names: ["united states", "usa", "united states of america"], loc: "US" },
  { names: ["united kingdom", "uk", "great britain"], loc: "GB" },
  { names: ["switzerland", "svizzera"], loc: "CH" },
  { names: ["netherlands", "holland"], loc: "NL" },
  { names: ["austria"], loc: "AT" },
  { names: ["greece"], loc: "GR" },
  { names: ["croatia"], loc: "HR" },
  { names: ["malta"], loc: "MT" },
  { names: ["cyprus"], loc: "CY" },
  { names: ["ireland"], loc: "IE" },
  { names: ["turkey", "turkiye"], loc: "TR" },
  { names: ["thailand"], loc: "TH" },
  { names: ["georgia"], loc: "GE" },
  { names: ["mexico"], loc: "MX" },
  { names: ["brazil", "brasil"], loc: "BR" },
  { names: ["argentina"], loc: "AR" },
  { names: ["colombia"], loc: "CO" },
]

export function residenceCountryToIso(addressCountry: string | null | undefined): string | null {
  if (!addressCountry) return null
  const norm = addressCountry.trim().toLowerCase()
  if (!norm) return null
  if (/^[A-Z]{2}$/.test(addressCountry.trim())) return addressCountry.trim()
  for (const { names, loc } of COUNTRY_NAME_TO_ISO) {
    if (names.some(n => norm === n || norm.includes(n))) return loc
  }
  return null
}
