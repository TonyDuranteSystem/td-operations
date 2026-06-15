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

const encoder = new TextEncoder()

/** URL-safe base64 of a string (edge + node safe, no Buffer dependency). */
function base64urlEncode(input: string): string {
  // btoa expects a binary string; encode UTF-8 bytes to latin1 first.
  const bytes = encoder.encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Constant-time string compare (length-leaking but value-safe). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return bytesToBase64url(new Uint8Array(sig))
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
 * `expFromNow` lets callers stamp the TTL; `now` is injectable for tests.
 */
export async function signViewAs(
  data: Omit<ViewAsPayload, 'exp'>,
  ttlMs: number,
  now: number = Date.now(),
): Promise<string> {
  const payload: ViewAsPayload = { ...data, exp: now + ttlMs }
  const body = base64urlEncode(JSON.stringify(payload))
  const sig = await hmacSha256(getSecret(), body)
  return `${body}.${sig}`
}

/**
 * Verify a token's signature and expiry. Returns the payload, or null when the
 * token is malformed, tampered, or expired. Never throws on bad input.
 * `now` is injectable for tests.
 */
export async function verifyViewAs(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ViewAsPayload | null> {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let expectedSig: string
  try {
    expectedSig = await hmacSha256(getSecret(), body)
  } catch {
    return null
  }
  if (!timingSafeEqualStr(sig, expectedSig)) return null

  let payload: ViewAsPayload
  try {
    payload = JSON.parse(base64urlDecode(body)) as ViewAsPayload
  } catch {
    return null
  }
  if (
    !payload ||
    typeof payload.contactId !== 'string' ||
    typeof payload.adminId !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  if (payload.exp <= now) return null
  return payload
}
