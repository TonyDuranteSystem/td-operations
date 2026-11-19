/**
 * Booking links — the random id that is the whole address of a link: app.tonydurante.us/r/b/<id>.
 * 16 random bytes = 128 bits, written as 22 URL-safe characters. No name, email or kind is ever in it.
 * Regexes below are LITERALS on purpose (R115: never build a RegExp from a template string).
 */

import { randomBytes } from "node:crypto"

export const LINK_ID_LENGTH = 22

export function newLinkId(): string {
  return randomBytes(16).toString("base64url")
}

/** The strict shape of an id we made. Anything else in utm_term (an ad keyword, a typo) is not an id and is ignored. */
export function isStrictLinkId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value)
}
