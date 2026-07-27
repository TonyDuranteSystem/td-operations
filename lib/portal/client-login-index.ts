/**
 * "Which contacts hold a CLIENT portal login?" — cached, for UI gating only.
 *
 * WHY THIS EXISTS
 * The account detail page must not offer "View as client" for a contact with no
 * portal login (the button opens that person's portal, so a login is the
 * precondition). Answering that needs the auth user list, and the only helper
 * available is `listAllAuthUsers()`, which pages through EVERY auth user via the
 * GoTrue admin API. Calling it per page view puts a full user scan on the CRM's
 * most-visited page — and `lib/auth-admin-helpers.ts` already warns its 1000-user
 * page cap is reachable within a year, at which point the scan becomes several
 * sequential full-page fetches added to render time.
 *
 * WHY A CACHE AND NOT A DB FUNCTION
 * The precise fix is a narrow SECURITY DEFINER function over `auth.users`. It was
 * attempted and abandoned: in this project a new `public` function is created with
 * EXECUTE granted to `anon`/`authenticated` by default, and the tooling available
 * here cannot issue the REVOKE that closes it — leaving an anonymous-callable
 * "does this contact have a login?" oracle. A short-lived in-memory cache gets
 * most of the benefit (staff browsing several accounts pay one scan, not one per
 * page) and adds no new reachable surface.
 *
 * STALENESS — DELIBERATELY BENIGN, BOTH DIRECTIONS
 *  - Login created moments ago → button may not appear for up to the TTL. It
 *    appears on the next load. No error, no data risk.
 *  - Login just deleted/revoked → button may linger for up to the TTL. Clicking
 *    it fails closed on the server, which already returns a clean "this client
 *    has no portal login" message.
 * Never use this for AUTHORIZATION. It gates a button's visibility only; the
 * view-as endpoints re-check the login server-side on every request.
 *
 * The cache is per server instance and dies with it — no cross-instance
 * coherence is assumed or needed for a visibility hint.
 */

import { listAllAuthUsers } from '@/lib/auth-admin-helpers'

/** How long a snapshot stays usable. Short enough that staff never fight it. */
export const CLIENT_LOGIN_CACHE_TTL_MS = 60_000

interface Snapshot {
  ids: Set<string>
  expiresAt: number
}

let snapshot: Snapshot | null = null
/** In-flight fetch, so N concurrent page renders trigger ONE scan, not N. */
let inFlight: Promise<Set<string>> | null = null

/** Pure: extract the contact ids that own a CLIENT login from an auth user list. */
export function clientLoginContactIds(
  users: Array<{ app_metadata?: { role?: string; contact_id?: string } | null }>,
): Set<string> {
  const ids = new Set<string>()
  for (const u of users) {
    const meta = u?.app_metadata
    if (meta?.role !== 'client') continue
    const id = meta?.contact_id
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

/** Drop the cached snapshot — call after creating or removing a portal login. */
export function invalidateClientLoginIndex(): void {
  snapshot = null
  inFlight = null
}

/**
 * Contact ids holding a CLIENT portal login, from cache when fresh.
 * `now` is injectable for tests.
 */
export async function getClientLoginContactIds(now: number = Date.now()): Promise<Set<string>> {
  if (snapshot && snapshot.expiresAt > now) return snapshot.ids
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const users = await listAllAuthUsers()
      const ids = clientLoginContactIds(
        users as Array<{ app_metadata?: { role?: string; contact_id?: string } | null }>,
      )
      snapshot = { ids, expiresAt: now + CLIENT_LOGIN_CACHE_TTL_MS }
      return ids
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
