/**
 * Booking page — the plain words shown while the page is TURNED OFF (the `booking` setting is absent, malformed or "off"). Client-safe: no imports.
 * While off, an administrator can open the page and look at its real screens, but nothing on it can make, stop, send or answer anything, and the routes refuse every change.
 * The words are short and in Antonio's language: no setting names, no jargon. He never gets a switch: Claude turns it on when he says.
 */

export const OFF_TITLE = "Turned off. Nothing here is live yet."
export const OFF_TEXT = "You can look around, but nothing on this page works until you tell Claude to turn it on."
/** the short reason shown beside a control that is inactive while off */
export const OFF_REASON = "Turned off"
/** what a route answers to any change while off */
export const OFF_REFUSAL = "Turned off. Nothing here is live yet."
