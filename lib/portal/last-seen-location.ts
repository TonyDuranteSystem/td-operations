/**
 * Passive capture of a client's last real connection location, from Vercel's
 * IP-geolocation request headers (`x-vercel-ip-timezone`) — taken only on a
 * genuine client portal visit, never during staff "View as client" (the
 * connection there is the STAFF's, not the client's). Lets the portal's
 * "Your Time" clock show, under View-as, where the client's own connection
 * actually was most recently, instead of only a possibly-stale address on
 * file — see resolveYourTimeZone in lib/portal/client-timezone.ts.
 */

/** Minimum gap between writes, so a client browsing several pages in a row
 *  doesn't trigger a database update on every single page navigation. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

/** A header value is never trusted as-is — it must parse as a real IANA
 *  timezone before it's written or used to resolve the clock. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Whether a fresh capture is due, given the last recorded timestamp. */
export function shouldRefreshLastSeen(
  lastSeenAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastSeenAt) return true
  const last = new Date(lastSeenAt).getTime()
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= REFRESH_INTERVAL_MS
}
