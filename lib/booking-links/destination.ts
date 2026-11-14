/**
 * Booking links — the Calendly address a link sends the visitor to. PURE.
 *
 * The page /r/b/<id> (Stage 1b) looks the link up and redirects to Calendly with the link id added as utm_term (this is what the webhook reads back) and the
 * person's name and email pre-filled. The destination must be a plain https calendly.com address — never another host, never credentials or a port in the
 * address — checked before AND after the extra parts are added, so a stored address (or a bug) can never turn this page into an open redirect.
 */

const CALENDLY_HOST = "calendly.com"

export interface DestinationParts {
  /** the link's own public id: becomes utm_term (and is the only tag we add) */
  linkId: string
  name?: string | null
  email?: string | null
}

function isCalendlyUrl(u: URL): boolean {
  return u.protocol === "https:" && u.hostname === CALENDLY_HOST && u.port === "" && u.username === "" && u.password === ""
}

/** Returns the full address, or null when the stored address is not a plain https calendly.com address (the caller answers "not available", never redirects). */
export function buildDestination(storedUrl: string | null | undefined, parts: DestinationParts): string | null {
  if (!storedUrl) return null
  let url: URL
  try {
    url = new URL(storedUrl)
  } catch {
    return null
  }
  if (!isCalendlyUrl(url)) return null
  url.searchParams.set("utm_term", parts.linkId)
  if (parts.name && parts.name.trim()) url.searchParams.set("name", parts.name.trim().slice(0, 100))
  if (parts.email && parts.email.trim()) url.searchParams.set("email", parts.email.trim().slice(0, 200))
  return isCalendlyUrl(url) ? url.toString() : null
}
