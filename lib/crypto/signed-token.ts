/**
 * Generic HMAC-SHA256 signed token — `<base64url(json)>.<base64url(hmac)>`.
 *
 * ⛔ ONE crypto stack, reused. This is the core the council required both signed
 * artifacts to share: the admin "View as client" pass (lib/portal/view-as.ts)
 * and the OA portal-iframe pass (lib/oa/portal-pass.ts). A second hand-rolled
 * mint/verify is exactly the one-off the next session would not find, and two
 * stacks drift (edge-vs-node crypto, TTL conventions, secret sourcing).
 *
 * Uses Web Crypto (`crypto.subtle`) so the SAME verify path runs in Node route
 * handlers AND in edge middleware. Never use the Node `crypto` module here — it
 * is not available in the edge runtime.
 *
 * The signed body is opaque JSON. Each caller defines its own payload type and
 * its own field validator; this core only guarantees integrity (not tampered)
 * and, when the payload carries `exp`, expiry. It intentionally knows nothing
 * about what the fields MEAN — binding the right fields (an OA pass must bind
 * oa_id, a view-as token binds contactId) and checking them is the caller's job.
 */

const encoder = new TextEncoder()

/** URL-safe base64 of a string (edge + node safe, no Buffer dependency). */
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

/** Constant-time string compare (length-leaking but value-safe). */
export function timingSafeEqualStr(a: string, b: string): boolean {
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

/**
 * Sign a payload object into a token. `now` is injectable for tests. The payload
 * is serialized verbatim — callers that want expiry put an `exp` epoch-ms field
 * in it (this core does not add one; `signSignedTokenWithTtl` is the helper for
 * that common case).
 */
export async function signSignedToken(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!secret) throw new Error('signed-token: secret is empty')
  const body = base64urlEncode(JSON.stringify(payload))
  const sig = await hmacSha256(secret, body)
  return `${body}.${sig}`
}

/** Convenience: stamp `exp = now + ttlMs` onto the payload, then sign. */
export async function signSignedTokenWithTtl(
  secret: string,
  data: Record<string, unknown>,
  ttlMs: number,
  now: number = Date.now(),
): Promise<string> {
  return signSignedToken(secret, { ...data, exp: now + ttlMs })
}

/**
 * Verify a token's HMAC and (if present) its `exp`. Returns the decoded payload
 * object on success, or null when the token is malformed, tampered, or expired.
 * NEVER throws on bad input — a bad token is a null, not a crash.
 *
 * `exp`, when present, must be a number and strictly in the future. A payload
 * with no `exp` verifies on signature alone (the caller is then responsible for
 * its own freshness rule); pass `requireExp` to reject a missing/!numeric exp.
 */
export async function verifySignedToken(
  secret: string,
  token: string | undefined | null,
  opts: { now?: number; requireExp?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const now = opts.now ?? Date.now()
  if (!secret) return null
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let expectedSig: string
  try {
    expectedSig = await hmacSha256(secret, body)
  } catch {
    return null
  }
  if (!timingSafeEqualStr(sig, expectedSig)) return null

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(base64urlDecode(body)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const exp = payload.exp
  if (opts.requireExp && typeof exp !== 'number') return null
  if (typeof exp === 'number' && exp <= now) return null

  return payload
}
