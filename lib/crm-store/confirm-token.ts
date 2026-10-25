/**
 * The confirmation for a change that needs one (an amended return): a short-lived token the SERVER hands to the signed-in web page
 * and checks when the page sends it back (dev job bd21e833, master plan Part 54). It is tied to ONE file, the version the person
 * started from, the person, and the exact bytes — so it cannot confirm anything else. The Mac app and Claude have no way to get one.
 * Stateless (HMAC), valid 5 minutes. The key is the first of STORE_CONFIRM_SECRET / CRON_SECRET that exists; with none, no token
 * can be made or accepted (fails closed).
 */
import { createHmac, timingSafeEqual } from "crypto"

export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000

export interface ConfirmScope { fileId: string; baseVersionNo: number; userId: string; sha256: string }

function secret(): string | null {
  return process.env.STORE_CONFIRM_SECRET || process.env.CRON_SECRET || null
}

const body = (s: ConfirmScope, exp: number) => `${s.fileId}|${s.baseVersionNo}|${s.userId}|${s.sha256}|${exp}`
const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest("base64url")

export function mintConfirmToken(s: ConfirmScope, now: number = Date.now(), key: string | null = secret()): string | null {
  if (!key) return null
  const exp = now + CONFIRM_TOKEN_TTL_MS
  return `${exp}.${sign(key, body(s, exp))}`
}

export function verifyConfirmToken(token: string | null | undefined, s: ConfirmScope, now: number = Date.now(), key: string | null = secret()): boolean {
  if (!key || !token) return false
  const dot = token.indexOf(".")
  if (dot < 1) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isFinite(exp) || exp < now || exp > now + CONFIRM_TOKEN_TTL_MS + 1000) return false
  const given = Buffer.from(token.slice(dot + 1))
  const want = Buffer.from(sign(key, body(s, exp)))
  return given.length === want.length && timingSafeEqual(given, want)
}
