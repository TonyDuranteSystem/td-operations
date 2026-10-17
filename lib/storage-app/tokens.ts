/**
 * TD Storage Mac app — token helpers (dev job 1992a087). PURE: no database, no network.
 *
 * Sign-in is the standard OAuth 2.0 code flow with PKCE and a loopback redirect (RFC 7636 / RFC 8252). Every secret is a random
 * opaque string (never a Supabase JWT, so no other part of the CRM can accept it) and only its SHA-256 hash is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto"

export const ACCESS_TTL_MS = 15 * 60_000            // access token: 15 minutes
export const CODE_TTL_MS = 60_000                   // authorization code: 60 seconds, single use
export const DEVICE_MAX_AGE_MS = 30 * 86_400_000    // a device must be approved again after 30 days (refresh chain cap)
export const REFRESH_GRACE_MS = 10_000              // a refresh token used twice within 10 s is treated as a lost response, not theft

export type SecretKind = "access" | "refresh" | "code"
const PREFIX: Record<SecretKind, string> = { access: "sa_at_", refresh: "sa_rt_", code: "sa_ac_" }

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** A fresh 256-bit secret with a kind prefix (the prefix is only a human label — the hash covers the whole string). */
export function newSecret(kind: SecretKind): { token: string; hash: string } {
  const token = PREFIX[kind] + randomBytes(32).toString("base64url")
  return { token, hash: hashSecret(token) }
}

/** The kind a presented token claims to be, from its label; null for anything else. */
export function secretKind(token: string): SecretKind | null {
  for (const k of Object.keys(PREFIX) as SecretKind[]) if (token.startsWith(PREFIX[k])) return k
  return null
}

/** PKCE S256: base64url(sha256(verifier)). */
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/

export function isValidChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge)
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false
  const a = Buffer.from(pkceS256(verifier))
  const b = Buffer.from(challenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The only redirect the app may use: exactly http://127.0.0.1:<port>/cb — the Mac's own loopback, a high port, no query,
 * no fragment, no user info, no other host (never "localhost", never a wildcard).
 */
export function isValidLoopbackRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 60) return false
  const m = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/cb$/.exec(uri)
  if (!m) return false
  const port = Number(m[1])
  return port >= 1024 && port <= 65535
}

export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^Bearer ([A-Za-z0-9_\-]{20,200})$/.exec(header.trim())
  return m ? m[1] : null
}

/** An IP kept only in shortened form (privacy): IPv4 → a.b.c.0, IPv6 → first four groups. */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const first = ip.split(",")[0].trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first.replace(/\.\d{1,3}$/, ".0")
  if (first.includes(":")) return first.split(":").slice(0, 4).join(":") + "::"
  return null
}

/** A device name from the app: trimmed, printable, 1–80 characters. */
export function cleanDeviceName(name: unknown): string | null {
  if (typeof name !== "string") return null
  const t = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return t.length >= 1 && t.length <= 80 ? t : null
}

/**
 * A short code the app SHOWS and the approval page SHOWS, derived from the PKCE challenge (so both sides compute the same one with no
 * server state). The person approving compares the two: a link somebody else started would show a different code.
 * Format "ABCD-EFGH" from an alphabet without look-alike characters.
 */
export function checkCode(challenge: string): string {
  const digest = createHash("sha256").update("td-storage-check:" + challenge, "utf8").digest()
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let out = ""
  for (let i = 0; i < 8; i++) out += alphabet[digest[i] % alphabet.length]
  return out.slice(0, 4) + "-" + out.slice(4)
}
