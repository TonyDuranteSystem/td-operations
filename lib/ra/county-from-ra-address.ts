/**
 * Resolve "County, State" for SS-4 Line 6 from an account's `registered_agent_address`.
 *
 * IRS SS-4 Line 6 instruction: "Enter the entity's primary physical location."
 * TD operating rule (Antonio, 2026-04-30): for foreign-owned LLC EIN filings, the
 * registered agent / registered office address is the source for Line 6.
 *
 * This helper is the IMMEDIATE-HOTFIX bridge until the structured `registered_agents`
 * table (Path 2) ships. It matches the free-text `registered_agent_address` against
 * a small set of known canonical RA addresses and returns the verified county/state
 * for that specific address. Unknown / blank / unmappable addresses return null —
 * the caller MUST block SS-4 advancement when null. There is no fallback, no
 * formation-state map, no default value.
 */

export interface RACountyMatch {
  countyAndState: string
  matchedCanonical: string
  source: "ra-address-known"
}

interface CanonicalRA {
  /** Pretty-printed canonical form, returned in `matchedCanonical` for traceability. */
  canonical: string
  /** Tokens that MUST all be present in the normalized input for a match. */
  requiredTokens: string[]
  /** Verified county and full state name. */
  countyAndState: string
}

const KNOWN_RA_ADDRESSES: CanonicalRA[] = [
  {
    canonical: "30 N Gould St STE R, Sheridan WY 82801",
    requiredTokens: ["30", "gould", "sheridan"],
    countyAndState: "Sheridan County, Wyoming",
  },
  {
    canonical: "1095 Sugar View Dr STE 500, Sheridan WY 82801",
    requiredTokens: ["1095", "sugar", "sheridan"],
    countyAndState: "Sheridan County, Wyoming",
  },
  {
    canonical: "1507 Lampman Ct, Cheyenne WY 82007",
    requiredTokens: ["1507", "lampman", "cheyenne"],
    countyAndState: "Laramie County, Wyoming",
  },
  {
    canonical: "7901 4th St N STE 300, St. Petersburg FL 33702",
    requiredTokens: ["7901", "petersburg"],
    countyAndState: "Pinellas County, Florida",
  },
  {
    canonical: "1200 S Pine Island Rd STE 200, Plantation FL 33324",
    requiredTokens: ["1200", "plantation"],
    countyAndState: "Broward County, Florida",
  },
  {
    canonical: "16192 Coastal Highway, Lewes DE 19958",
    requiredTokens: ["16192", "lewes"],
    countyAndState: "Sussex County, Delaware",
  },
  {
    canonical: "1209 Mountain Road Pl NE STE R, Albuquerque NM 87110",
    requiredTokens: ["1209", "mountain", "albuquerque"],
    countyAndState: "Bernalillo County, New Mexico",
  },
  {
    canonical: "2929 Coors Blvd NW STE 101, Albuquerque NM 87120",
    requiredTokens: ["2929", "coors", "albuquerque"],
    countyAndState: "Bernalillo County, New Mexico",
  },
]

/** Lowercase, strip punctuation, collapse whitespace. Result is a space-separated token stream. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Match a raw `registered_agent_address` to a known canonical RA address.
 *
 * Returns the verified county/state for that specific address, or null when:
 * - input is blank/whitespace/null/undefined
 * - input does not contain all required tokens of any known canonical address
 *
 * Matching is token-based (street number + distinctive street/city tokens), so
 * STE/Suite/Ste, comma/no-comma, missing-state, missing-zip, and case variants
 * all match the same canonical row. New / unknown addresses return null —
 * never a guess.
 */
export function countyFromRAAddress(rawAddress: string | null | undefined): RACountyMatch | null {
  if (!rawAddress) return null
  const normalized = normalize(rawAddress)
  if (!normalized) return null

  for (const entry of KNOWN_RA_ADDRESSES) {
    const allTokensPresent = entry.requiredTokens.every((token) => {
      const re = new RegExp(`(^|\\s)${token}(\\s|$)`)
      return re.test(normalized)
    })
    if (allTokensPresent) {
      return {
        countyAndState: entry.countyAndState,
        matchedCanonical: entry.canonical,
        source: "ra-address-known",
      }
    }
  }
  return null
}

/** Exposed for tests: list of canonical addresses currently supported. */
export const KNOWN_RA_CANONICALS: ReadonlyArray<{ canonical: string; countyAndState: string }> =
  KNOWN_RA_ADDRESSES.map((e) => ({ canonical: e.canonical, countyAndState: e.countyAndState }))
