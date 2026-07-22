/**
 * TD's office address — the SINGLE source.
 *
 * Why this file exists: the address was written out by hand in eleven separate
 * source files, and a comment in one of them claimed it lived in two others and
 * named the wrong ones. If the office ever moves, whoever follows that comment
 * updates a few sites and misses the rest — and a client posts their ORIGINAL
 * wet-ink W-7 and passport copies to an address that no longer exists. Those do
 * not come back.
 *
 * IMPORTANT — this is one VALUE with three distinct PURPOSES. They are equal
 * today and could legitimately diverge tomorrow (a new document-receiving
 * office, a changed registered address). Each purpose therefore gets its own
 * named export, so a future split is a one-line edit here rather than a hunt
 * through the codebase:
 *
 *   1. MAILING_DESTINATION — where CLIENTS post their signed documents to us.
 *      Used by the client-facing ITIN instructions and the emails that carry
 *      them. This is the one that must never go stale.
 *
 *   2. CAA_IDENTITY_ADDRESS — TD's address as Certified Acceptance Agent,
 *      printed on the W-7 beside the EIN / PTIN / office code. A regulated
 *      identity block, not a delivery address.
 *
 *   3. CLIENT_ADDRESS_FALLBACK — stands in for the CLIENT's company address on
 *      the SS-4 when their account has none on file. Semantically it is the
 *      client's address, not ours; it merely borrows our office today.
 *
 * If you are tempted to collapse these into one constant: don't. They mean
 * different things, and merging them means they move together when only one
 * should.
 */

/** The office, in parts. Every export below is derived from this. */
export const TD_OFFICE = {
  company: "Tony Durante LLC",
  street: "11125 Park Blvd, Suite 104-153",
  streetNoSuite: "11125 Park Blvd",
  city: "Seminole",
  state: "FL",
  zip: "33772",
  country: "United States",
} as const

/** "Seminole, FL 33772" */
export const TD_CITY_STATE_ZIP = `${TD_OFFICE.city}, ${TD_OFFICE.state} ${TD_OFFICE.zip}`

// ── 1. Where clients post documents to us ───────────────────────────────────

/** Address block for client-facing instructions, one line per array entry. */
export const MAILING_DESTINATION_LINES: readonly string[] = [
  TD_OFFICE.company,
  TD_OFFICE.street,
  TD_CITY_STATE_ZIP,
  TD_OFFICE.country,
]

/** Same block as a single string, for plain-text email bodies. */
export const MAILING_DESTINATION_TEXT = MAILING_DESTINATION_LINES.join("\n")

/** Same block as HTML, for email templates. */
export const MAILING_DESTINATION_HTML = `<strong>${TD_OFFICE.company}</strong><br/>${TD_OFFICE.street}<br/>${TD_CITY_STATE_ZIP}<br/>${TD_OFFICE.country}`

// ── 2. TD as Certified Acceptance Agent, on the W-7 ─────────────────────────

export const CAA_IDENTITY_ADDRESS = {
  mailingStreet: TD_OFFICE.street,
  mailingCityStateZip: `${TD_CITY_STATE_ZIP}, ${TD_OFFICE.country}`,
} as const

/** One-line form, as the 1040-NR expects it. */
export const CAA_ADDRESS_ONE_LINE = `${TD_OFFICE.street}, ${TD_CITY_STATE_ZIP}`

// ── 3. Fallback for a client company with no address on file (SS-4) ─────────

export const CLIENT_ADDRESS_FALLBACK = {
  street: TD_OFFICE.street,
  cityStateZip: TD_CITY_STATE_ZIP,
} as const
