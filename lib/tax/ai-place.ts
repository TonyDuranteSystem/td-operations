/**
 * S2 — AI place field: pure decision logic for stamping an AI-read country
 * onto a merchant group's rows (loc_source='ai').
 *
 * Containment (dual-review conditions, 2026-07-05):
 *  - the AI only proposes a place when the description carries an explicit
 *    anchor token (prompted + gate-measured); this module adds the WHITELIST:
 *    a proposed country is stamped only when the workspace has INDEPENDENT
 *    evidence for it — a deterministic (text/map) location in that country, or
 *    the group's own statement currency belonging to that country's zone.
 *    A country the AI alone claims is skipped in v1 (conservative; the
 *    accuracy gate can widen this later).
 *  - AI stamps never overwrite deterministic labels (enforced by the caller).
 *  - AI-located rows never create presence periods (enforced in the period
 *    pipeline, which reads deterministic sources only).
 *  - groups smaller than MIN_GROUP_ROWS are never stamped (a single vague line
 *    is not enough signal to place a merchant).
 */

export const AI_PLACE_MIN_GROUP_ROWS = 3

/** Countries using the euro — an EUR-denominated statement is independent
 *  evidence for any of them. */
const EUROZONE = new Set([
  "AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
])

/** Single-country currency zones. Deliberately NOT exhaustive — a currency
 *  missing here simply contributes no whitelist evidence. */
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: "US", GBP: "GB", AED: "AE", CHF: "CH", PLN: "PL", SEK: "SE",
  DKK: "DK", NOK: "NO", CZK: "CZ", HUF: "HU", RON: "RO", BGN: "BG",
  TRY: "TR", MXN: "MX", BRL: "BR", CAD: "CA", AUD: "AU", JPY: "JP",
  SGD: "SG", HKD: "HK", INR: "IN", SAR: "SA", QAR: "QA", KWD: "KW",
}

/** Does `currency` count as independent evidence for `country`? */
export function currencyCoversCountry(currency: string | null | undefined, country: string): boolean {
  const cur = (currency ?? "").toUpperCase()
  if (!cur) return false
  if (cur === "EUR") return EUROZONE.has(country)
  return CURRENCY_COUNTRY[cur] === country
}

export interface PlaceStampInput {
  /** ISO alpha-2 the AI proposed (already shape-validated by the parser). */
  place: string
  /** Number of rows in the merchant group. */
  groupSize: number
  /** The group's statement currency. */
  currency: string | null | undefined
  /** Countries with deterministic (text/map) location evidence in this workspace. */
  deterministicCountries: ReadonlySet<string>
}

/** True when the AI-proposed place clears every containment guard and may be
 *  stamped (loc_source='ai') on the group's unlabeled rows. */
export function decidePlaceStamp(input: PlaceStampInput): boolean {
  const place = input.place.toUpperCase()
  if (!/^[A-Z]{2}$/.test(place)) return false
  if (input.groupSize < AI_PLACE_MIN_GROUP_ROWS) return false
  if (input.deterministicCountries.has(place)) return true
  return currencyCoversCountry(input.currency, place)
}
