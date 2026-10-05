/**
 * The staff "preview this offer" link (dev job b834e4ae).
 *
 * Staff must open an offer through the CRM preview route, which proves staff identity, mints a
 * 30-minute pass bound to this offer and redirects to the offer page — so the visit is never
 * counted as the client opening it. A bare `<offer_url>?preview=td` carries no staff proof on the
 * client host (the staff cookie does not exist there) and IS counted. Every CRM surface that links
 * to an offer for staff should build the href here. Relative on purpose: it resolves against the
 * CRM host the staff member is already signed in to.
 */
export function offerPreviewHref(token: string): string {
  return `/api/crm/offer-preview?token=${encodeURIComponent(token)}`
}
