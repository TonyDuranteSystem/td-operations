/**
 * TD Marketing — invite rules (pure; P1, dev job 9aec66fa). An invite is a single-use, expiring link. Only the HASH of the
 * token is stored; the link carries the token. The accept step answers with ONE generic message for every failure, so it
 * can never reveal whether an email already belongs to a client, a staff member or an admin.
 */
import crypto from "node:crypto"

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_INVITES_PER_OWNER_PER_HOUR = 20
export const MIN_PASSWORD_LENGTH = 12
export const GENERIC_INVITE_ERROR = "This invitation cannot be used. Ask the person who sent it for a new one, and if it keeps failing, ask for it to be sent to a different email address."
export const TRY_AGAIN_ERROR = "Something went wrong. Please try again in a moment."
export const WEAK_PASSWORD_ERROR = "Choose a stronger password and try again."

type AuthErrorLike = { code?: string; status?: number; message?: string } | null | undefined
/** The login system refused to create the login because the email already has one (a client, staff, admin, partner or marketing login). */
export function isEmailTakenError(err: AuthErrorLike): boolean {
  if (!err) return false
  if (err.code === "email_exists" || err.code === "user_already_exists") return true
  return err.status === 422 && /already|registered|exists/i.test(err.message ?? "")
}
/** The login system refused the password itself (too weak, found in a leak list ...): nothing was created, the person can retry. */
export function isWeakPasswordError(err: AuthErrorLike): boolean {
  if (!err) return false
  if (err.code === "weak_password") return true
  return /password/i.test(err.message ?? "") && /weak|short|least|strong|pwned|compromised|leak/i.test(err.message ?? "")
}
/** An existing login that WE created and never finished: a marketing login with no team membership at all (an earlier acceptance crashed
 *  between creating the login and saving the membership). Anyone else's login is never ours to finish. */
export function isOrphanMarketingLogin(role: unknown, membershipCount: number): boolean {
  return typeof role === "string" && role.trim().toLowerCase() === "marketing" && membershipCount === 0
}

export function newInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url")
}
export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}
export function plausibleToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(t)
}
export function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null
  const v = e.trim().toLowerCase()
  if (v.length > 254) return null
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(v) ? v : null
}
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string" || p.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (p.length > 200) return "That password is too long."
  if (/^(.)\1+$/.test(p)) return "Choose a password that is not one repeated character."
  return null
}

export interface InviteRow { used_at: string | null; revoked_at: string | null; expires_at: string }
/** Usable = not used, not revoked, not expired. */
export function inviteUsable(inv: InviteRow | null | undefined, now: Date): boolean {
  if (!inv) return false
  if (inv.used_at || inv.revoked_at) return false
  const exp = new Date(inv.expires_at).getTime()
  return Number.isFinite(exp) && exp > now.getTime()
}
export function inviteExpiry(now: Date): string {
  return new Date(now.getTime() + INVITE_TTL_MS).toISOString()
}
export function overInviteLimit(countLastHour: number): boolean {
  return countLastHour >= MAX_INVITES_PER_OWNER_PER_HOUR
}
