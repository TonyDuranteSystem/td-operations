/**
 * Admin "View as client" (read-only portal impersonation) — token + marker signing.
 *
 * Two signed artifacts share this helper, both HMAC-SHA256 over a JSON payload:
 *
 *  1. AUTHORIZATION TOKEN — minted by the admin-only dashboard endpoint
 *     (`/api/admin/view-as`) after it verifies the caller is an admin, and
 *     consumed once by the portal entry route (`/portal/view-as`). Short TTL
 *     (~2 min). Proves "an admin authorized opening this client's view".
 *
 *  2. MARKER COOKIE (`td_view_as`) — set by the entry route after it mints the
 *     client session, read by middleware (to enforce read-only) and by the
 *     portal layout (to render the banner). Longer TTL (~30 min).
 *
 * Both use Web Crypto (`crypto.subtle`) so the SAME verify path runs in Node
 * route handlers AND in the edge middleware. Never use the Node `crypto` module
 * here — it is not available in the edge runtime.
 *
 * SECURITY NOTE (documented limitation): the marker cookie enforces read-only by
 * its PRESENCE. Forging it only LOCKS the holder to read-only (a penalty, not an
 * escalation); the actual client session is granted only by the verified
 * authorization token. A determined admin with browser dev-tools could delete
 * the marker to escape read-only — this tool prevents ACCIDENTAL writes while
 * viewing, it is not a sandbox against a deliberate admin. Admin-only + audited.
 */

import { signSignedTokenWithTtl, verifySignedToken } from '@/lib/crypto/signed-token'

export const VIEW_AS_COOKIE = 'td_view_as'

/** Default TTLs (ms). */
export const AUTH_TOKEN_TTL_MS = 2 * 60 * 1000 // 2 minutes — single-use handoff
export const MARKER_TTL_MS = 30 * 60 * 1000 // 30 minutes — viewing window

export interface ViewAsPayload {
  /** contacts.id of the client being viewed */
  contactId: string
  /** auth user id of the admin who authorized the view (audit) */
  adminId: string
  /** epoch ms after which the artifact is invalid */
  exp: number
}

function getSecret(): string {
  const secret = process.env.API_SECRET_TOKEN?.trim()
  if (!secret) {
    // Fail closed: without a secret we cannot sign or verify.
    throw new Error('VIEW_AS: API_SECRET_TOKEN is not configured')
  }
  return secret
}

/**
 * Sign a payload into a `<base64url(json)>.<base64url(hmac)>` token.
 * `ttlMs` stamps the TTL; `now` is injectable for tests. Delegates to the shared
 * signed-token core (lib/crypto/signed-token.ts) so this and the OA portal pass
 * share one crypto stack.
 */
export async function signViewAs(
  data: Omit<ViewAsPayload, 'exp'>,
  ttlMs: number,
  now: number = Date.now(),
): Promise<string> {
  return signSignedTokenWithTtl(getSecret(), { contactId: data.contactId, adminId: data.adminId }, ttlMs, now)
}

/**
 * Verify a token's signature and expiry. Returns the payload, or null when the
 * token is malformed, tampered, or expired. Never throws on bad input.
 * `now` is injectable for tests. The field validation below is unchanged — the
 * shared core guarantees integrity + expiry, this layer keeps view-as's own
 * shape check so a token minted for a different payload type cannot pass here.
 */
export async function verifyViewAs(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ViewAsPayload | null> {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return null
  }
  const payload = await verifySignedToken(secret, token, { now, requireExp: true })
  if (
    !payload ||
    typeof payload.contactId !== 'string' ||
    typeof payload.adminId !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  return payload as unknown as ViewAsPayload
}
