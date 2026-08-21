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

type AuthUserLike = {
  app_metadata?: { role?: string; contact_id?: string } | null
  user_metadata?: { must_change_password?: unknown } | null
}

interface Snapshot {
  ids: Set<string>
  needsSetupIds: Set<string>
  expiresAt: number
}

let snapshot: Snapshot | null = null
/** In-flight fetch, so N concurrent page renders trigger ONE scan, not N. */
let inFlight: Promise<Snapshot> | null = null

/** Pure: extract the contact ids that own a CLIENT login from an auth user list. */
export function clientLoginContactIds(users: AuthUserLike[]): Set<string> {
  const ids = new Set<string>()
  for (const u of users) {
    const meta = u?.app_metadata
    if (meta?.role !== 'client') continue
    const id = meta?.contact_id
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

/**
 * Pure: contact ids whose CLIENT login exists but has never finished the
 * first-time "Set Your Password" step — same truthiness convention as the
 * password gate itself (`!!user.user_metadata?.must_change_password`), so a
 * legacy login predating this flag (absent, not `false`) correctly counts as
 * usable rather than stuck. Deliberately does NOT use `last_sign_in_at` —
 * that timestamp is also stamped by an admin's "View as client" session
 * (restored afterward, but not instantly/reliably — auth-oauth.md 2026-06-15),
 * so it is not a trustworthy "this person genuinely logged in" signal. The
 * password flag can only ever be cleared by the account's own owner
 * completing their own password-set flow (`/api/portal/change-password`),
 * never by staff browsing — so it is tamper-resistant where the timestamp is not.
 */
export function clientLoginNeedsSetupIds(users: AuthUserLike[]): Set<string> {
  const ids = new Set<string>()
  for (const u of users) {
    const meta = u?.app_metadata
    if (meta?.role !== 'client') continue
    const id = meta?.contact_id
    if (typeof id !== 'string' || id.length === 0) continue
    if (u?.user_metadata?.must_change_password === true) ids.add(id)
  }
  return ids
}

/** Drop the cached snapshot — call after creating or removing a portal login. */
export function invalidateClientLoginIndex(): void {
  snapshot = null
  inFlight = null
}

async function loadSnapshot(now: number): Promise<Snapshot> {
  if (snapshot && snapshot.expiresAt > now) return snapshot
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const users = (await listAllAuthUsers()) as AuthUserLike[]
      const next: Snapshot = {
        ids: clientLoginContactIds(users),
        needsSetupIds: clientLoginNeedsSetupIds(users),
        expiresAt: now + CLIENT_LOGIN_CACHE_TTL_MS,
      }
      snapshot = next
      return next
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/**
 * Contact ids holding a CLIENT portal login, from cache when fresh.
 * `now` is injectable for tests.
 */
export async function getClientLoginContactIds(now: number = Date.now()): Promise<Set<string>> {
  const s = await loadSnapshot(now)
  return s.ids
}

/**
 * Contact ids whose CLIENT login has never finished first-time password
 * setup — from the SAME cached scan `getClientLoginContactIds` uses, so
 * calling both on one page render costs one auth-user scan, not two.
 * `now` is injectable for tests.
 */
export async function getClientLoginNeedsSetupIds(now: number = Date.now()): Promise<Set<string>> {
  const s = await loadSnapshot(now)
  return s.needsSetupIds
}
