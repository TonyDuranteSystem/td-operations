/**
 * Meta webhook checks (pure; TD Marketing, dev job 9aec66fa). Every Meta webhook fails CLOSED: a missing app secret or a missing
 * or wrong signature is a refusal, never a pass (unlike the older Calendly route, which skips the check when its secret is unset).
 * Meta signs the RAW request body with HMAC-SHA256 using the app secret and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 */
import crypto from "crypto"

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** True only when the header is `sha256=<hex>` and the hex equals HMAC-SHA256(rawBody, appSecret). */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string | null | undefined): boolean {
  if (!appSecret || !header) return false
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim())
  if (!m) return false
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")
  return safeEqual(m[1].toLowerCase(), expected)
}

export type HandshakeResult = { ok: true; challenge: string } | { ok: false }

/**
 * The subscription handshake: Meta calls GET with hub.mode=subscribe, hub.verify_token and hub.challenge. We answer the
 * challenge only when the token equals OUR random verify token. No configured token = refuse.
 */
export function checkVerifyHandshake(params: { mode?: string | null; token?: string | null; challenge?: string | null }, expectedToken: string | null | undefined): HandshakeResult {
  if (!expectedToken) return { ok: false }
  if (params.mode !== "subscribe") return { ok: false }
  if (!params.token || !safeEqual(params.token, expectedToken)) return { ok: false }
  if (!params.challenge) return { ok: false }
  return { ok: true, challenge: params.challenge }
}
