/**
 * Remember-device cookie for staff MFA (dev job de4564ee).
 *
 * Signed HMAC-SHA256 artifact in the view-as.ts style (Web Crypto, edge +
 * node safe — middleware verifies it in the edge runtime). Council-fixed
 * rules:
 *  - Minted ONLY after a real TOTP verify — never by a backup code, never
 *    at enrollment (Architect blocker: the cookie's one honest meaning is
 *    "this device recently passed TOTP").
 *  - HMAC input is DOMAIN-SEPARATED ("td_mfa_rd|" prefix) so this artifact
 *    can never be confused with the view-as token that shares the secret
 *    (Security minor #1).
 *  - Payload carries userId (verified against the CURRENT session user —
 *    shared-machine protection), exp (30 days), and version (compared to
 *    app_metadata.mfa_rd_version from the fresh getUser() result; a bump
 *    kills every device cookie at once — that IS the revocation mechanism).
 *  - The cookie deliberately SURVIVES sign-out: it is device trust, not
 *    session state; without that the 30-day promise is false. Theft is
 *    covered by the version bump. (Coordinator decision on a reviewer
 *    split, recorded on dev job de4564ee.)
 */

export const MFA_RD_COOKIE = 'td_mfa_rd'
export const MFA_RD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const DOMAIN_PREFIX = 'td_mfa_rd|'

export interface MfaRdPayload {
  userId: string
  /** epoch ms */
  exp: number
  /** must equal app_metadata.mfa_rd_version ?? 0 at verify time */
  version: number
}

const encoder = new TextEncoder()

function base64urlEncode(input: string): string {
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
    // Fail closed: no secret ⇒ cannot sign or verify ⇒ no device trust.
    throw new Error('MFA_RD: API_SECRET_TOKEN is not configured')
  }
  return secret
}

/** Sign a remember-device cookie value. `now` injectable for tests. */
export async function signMfaRememberDevice(
  data: { userId: string; version: number },
  now: number = Date.now(),
  ttlMs: number = MFA_RD_TTL_MS,
): Promise<string> {
  const payload: MfaRdPayload = { ...data, exp: now + ttlMs }
  const body = base64urlEncode(JSON.stringify(payload))
  const sig = await hmacSha256(getSecret(), DOMAIN_PREFIX + body)
  return `${body}.${sig}`
}

/**
 * Verify a remember-device cookie against the CURRENT session.
 * Returns true only when: signature valid (domain-separated), not expired,
 * payload.userId === currentUserId, payload.version === currentVersion.
 * Never throws on bad input; fails closed on missing secret.
 */
export async function verifyMfaRememberDevice(
  token: string | undefined | null,
  currentUserId: string,
  currentVersion: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token || typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return false
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let expectedSig: string
  try {
    expectedSig = await hmacSha256(getSecret(), DOMAIN_PREFIX + body)
  } catch {
    return false
  }
  if (!timingSafeEqualStr(sig, expectedSig)) return false

  let payload: MfaRdPayload
  try {
    payload = JSON.parse(base64urlDecode(body)) as MfaRdPayload
  } catch {
    return false
  }
  if (
    !payload ||
    typeof payload.userId !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.version !== 'number'
  ) {
    return false
  }
  if (payload.exp <= now) return false
  if (payload.userId !== currentUserId) return false
  if (payload.version !== currentVersion) return false
  return true
}
