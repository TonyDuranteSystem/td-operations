/**
 * Booking page — the plain words shown while the page is TURNED OFF (the `booking` setting is absent, malformed or "off"). Client-safe: no imports.
 * While off, any staff login can open the "Links and calls" tab and look at its real screens, but nothing on it can make, stop, send or answer anything, and the routes refuse every change.
 * The Leads tab is NOT affected: it works the same whether this is off, page or live. The words are short, in plain English, and speak to everyone who can open the page (staff too):
 * no setting names, no jargon, nothing about who turns it on. Claude turns it on when Antonio says; there is no switch on the page.
 */

export const OFF_TITLE = "Turned off. Nothing here is live yet."
export const OFF_TEXT = "You can look around, but nothing on this tab works until it is turned on. Leads is not affected."
/** the short reason shown beside a control that is inactive while off */
export const OFF_REASON = "Turned off"
/** what a route answers to any change while off */
export const OFF_REFUSAL = "Turned off. Nothing here is live yet."
