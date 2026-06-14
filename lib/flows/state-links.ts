/**
 * Secretary of State filing-portal links, resolved from an account's
 * state_of_formation. Used by the flow Workspace external_link component on the
 * Annual Report "Due Date" stage so staff can jump straight to the right state
 * portal to file.
 *
 * state_of_formation is stored inconsistently in the DB (verified sandbox
 * 2026-06-14: both "Wyoming" and "WY", "Florida"/"FL", "New Mexico"/"NM",
 * "Delaware", "Massachusetts"), so we normalize to a 2-letter code first —
 * mirroring the normalization already used in lib/service-delivery.ts.
 */

/** Normalize a free-text state into a 2-letter code, or null if unrecognized. */
export function normalizeStateCode(state: string | null | undefined): string | null {
  if (!state) return null
  const s = state.trim().toUpperCase()
  if (!s) return null
  const map: Record<string, string> = {
    WYOMING: 'WY',
    WY: 'WY',
    FLORIDA: 'FL',
    FL: 'FL',
    DELAWARE: 'DE',
    DE: 'DE',
    'NEW MEXICO': 'NM',
    NM: 'NM',
    MASSACHUSETTS: 'MA',
    MA: 'MA',
  }
  return map[s] ?? null
}

/**
 * Secretary of State annual-report filing portal by 2-letter state code.
 * NM intentionally absent — New Mexico LLCs have no annual report. Any state
 * without an entry resolves to null (no link shown).
 */
const SOS_PORTAL_URL: Record<string, string> = {
  WY: 'https://wyobiz.wyo.gov/',
  FL: 'https://dos.fl.gov/sunbiz/',
  DE: 'https://icis.corp.delaware.gov/ecorp/logintax.aspx',
}

export interface ResolvedStateLink {
  /** Normalized 2-letter code, or null if the state string was unrecognized. */
  stateCode: string | null
  /** Portal URL, or null when the state has no annual-report portal (e.g. NM)
   *  or is unrecognized. */
  url: string | null
  /** True when the state is recognized but has no annual report (NM). */
  noAnnualReport: boolean
}

/** Resolve the Secretary of State filing link for an account's state. */
export function resolveSecretaryOfStateLink(state: string | null | undefined): ResolvedStateLink {
  const stateCode = normalizeStateCode(state)
  return {
    stateCode,
    url: stateCode ? (SOS_PORTAL_URL[stateCode] ?? null) : null,
    noAnnualReport: stateCode === 'NM',
  }
}
