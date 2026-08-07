/**
 * Where staff actually performs a renewal (Antonio, 2026-08-07): the
 * calendar's action rows link to the FILING venue, not Drive — RA renewals
 * are done on Harbor Compliance; annual reports on the formation state's
 * Secretary-of-State portal.
 *
 * CLIENT-SAFE: no imports (the shared state normalizer lives in a module
 * that pulls the server-only database client, and this file is consumed by
 * a browser component). State lookup accepts both full names and codes.
 *
 * URLs are the long-standing portal entry points (same family the LLC
 * name-check card and the To-Do card already link to). If a portal moves,
 * update here — ONE map for every surface.
 */

export interface RenewalActionLink {
  url: string
  label: string
}

const HARBOR: RenewalActionLink = {
  url: "https://www.harborcompliance.com",
  label: "Harbor Compliance",
}

const WY = { url: "https://wyobiz.wyo.gov/business/annualreport.aspx", label: "WY SOS" }
const FL = { url: "https://services.sunbiz.org/Filings/AnnualReport/FilingStart", label: "Sunbiz" }
const DE = { url: "https://icis.corp.delaware.gov/ecorp/logintax.aspx", label: "DE SOS" }
const MA = { url: "https://corp.sec.state.ma.us/", label: "MA SOS" }

const SOS_AR_PORTALS: Record<string, RenewalActionLink> = {
  WY, WYOMING: WY,
  FL, FLORIDA: FL,
  DE, DELAWARE: DE,
  MA, MASSACHUSETTS: MA,
}

/** The filing venue for a calendar action row; null when unknown (row then
 *  shows nothing — the Mark-Filed dialog still carries the Drive folder). */
export function renewalActionLink(
  kind: "ra" | "ar",
  stateOfFormation: string | null | undefined,
): RenewalActionLink | null {
  if (kind === "ra") return HARBOR
  const state = (stateOfFormation || "").toUpperCase().trim()
  return SOS_AR_PORTALS[state] ?? null
}
