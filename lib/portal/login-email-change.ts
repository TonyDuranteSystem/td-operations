/**
 * Client changes their OWN portal login email — the pure rules (dev job beb43385, step 2).
 *
 * The flow (Antonio approved the mockup 2026-11-17/18): the client types the new email and their
 * password, a 6-digit code goes to the NEW address, and the login moves only when the code is
 * entered. The OLD address then gets a note with a "This wasn't me" button (single-use link,
 * 7 days) that puts the old email back and asks for a new password.
 *
 * Everything here is pure (no database, no network, no clock except the `now` passed in), so it
 * is unit-tested without a server. The numbers live in ONE place (LOGIN_EMAIL_CHANGE) so they can
 * be changed without hunting through the flow.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto"

export const LOGIN_EMAIL_CHANGE = {
  /** Digits in the code sent to the new address. */
  codeLength: 6,
  /** How long a code works. */
  codeTtlMs: 15 * 60 * 1000,
  /** A new code may be asked for after this long. */
  resendAfterMs: 60 * 1000,
  /** Codes that may be sent for ONE request (the first plus resends). */
  maxCodeSends: 5,
  /** Code attempts on one request, right or wrong. The attempt is counted BEFORE it is judged. */
  maxCodeAttempts: 5,
  /** Wrong passwords at step 1 (per login, inside lockMs) before step 1 refuses. */
  maxPasswordAttempts: 5,
  /** How long a lock lasts, and the window password attempts are counted in. */
  lockMs: 15 * 60 * 1000,
  /** How many times a client may START a change (a code email each) inside the window. */
  maxStartsPerWindow: 5,
  startWindowMs: 60 * 60 * 1000,
  /** How long the "This wasn't me" link works. */
  undoTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Shortest password the undo page accepts (same as the change-password route). */
  minPasswordLength: 8,
} as const

/** This repo builds without strictNullChecks, where `if (!r.ok)` does NOT narrow a result union. This guard does. */
export function isFailure<T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> {
  return r.ok === false
}

export type LoginEmailChangeStatus =
  | "pending" // code sent, not yet entered
  | "confirmed" // login moved; the undo link may still be used
  | "undone" // the "This wasn't me" link was used
  | "cancelled" // replaced by a newer request, or abandoned
  | "password_check" // step 1: a password is being checked (written BEFORE the check, so parallel guesses are counted)
  | "password_failed" // step 1: that password was wrong (kept only to count attempts)

/** Lower-case + trim: the form every comparison and every stored email uses. */
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : ""
}

/** A deliberately plain shape check; the real proof is the code that arrives in the mailbox. */
export function isPlausibleEmail(email: string): boolean {
  if (!email || email.length > 254) return false
  if (/\s/.test(email) || /[<>(),;:"\\[\]]/.test(email)) return false
  const at = email.indexOf("@")
  if (at < 1 || at !== email.lastIndexOf("@")) return false
  const domain = email.slice(at + 1)
  if (domain.length < 3 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false
  return domain.includes(".") && domain.lastIndexOf(".") < domain.length - 2
}

/** A fresh random numeric code, zero-padded ("004829"). */
export function generateCode(): string {
  return String(randomInt(0, 10 ** LOGIN_EMAIL_CHANGE.codeLength)).padStart(LOGIN_EMAIL_CHANGE.codeLength, "0")
}

/** Keep only the digits of what the client typed ("483 291" -> "483291"). */
export function cleanCode(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : ""
}

/** "483 291" for the email: easier to read and to copy than six digits in a row. */
export function formatCodeForEmail(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/**
 * Hash for a code or an undo-link secret. Keyed with the server secret AND bound to the request id,
 * so a leaked row cannot be turned into a code without the secret, and one request's hash is
 * useless for another. (A 6-digit code is brute-forceable offline from a leaked hash; the real
 * defence is the attempt limit and the 15 minutes. The key + binding keeps a leaked row from helping.)
 */
export function hashSecret(key: string, requestId: string, value: string): string {
  return createHmac("sha256", key).update(`${requestId}:${value}`).digest("hex")
}

/** Constant-time compare of two hex hashes. Anything that is not a clean hex string never matches. */
export function hashesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false
  const ba = Buffer.from(a, "hex")
  const bb = Buffer.from(b, "hex")
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

/**
 * The "This wasn't me" link token: `<request id>.<random secret>`. The request id lets the page find
 * the row; only the hash of the secret is stored. 32 random bytes = nothing to guess.
 */
export function generateUndoToken(requestId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url")
  return { token: `${requestId}.${secret}`, secret }
}

export function parseUndoToken(raw: unknown): { requestId: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length > 200) return null
  const dot = raw.indexOf(".")
  if (dot !== 36) return null
  const requestId = raw.slice(0, 36)
  const secret = raw.slice(37)
  if (!isUuid(requestId) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null
  return { requestId, secret }
}

export interface LoginIdentity {
  authUserId: string
  contactId: string
  currentEmail: string
}

/** A normal client login (role client, tied to a contact, with an email). Team logins and everyone else get null. */
export function loginIdentityFromUser(user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> } | null): LoginIdentity | null {
  if (!user || user.app_metadata?.role !== "client") return null
  const contactId = user.app_metadata?.contact_id
  const email = (user.email ?? "").trim()
  if (typeof contactId !== "string" || !contactId || !email) return null
  return { authUserId: user.id, contactId, currentEmail: email }
}

// ─── the decisions (pure: given the numbers, say what happens) ──────────────────────────────────

/** The row of a code attempt AFTER the database counted it (portal_login_email_take_attempt). */
export interface CountedAttempt {
  /** false = the attempt was refused and not counted (not open, locked, expired or out of attempts). */
  taken: boolean
  status: string
  codeExpiresAt: Date | null
  attempts: number
  lockedUntil: Date | null
}

export type AttemptJudgement =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "locked" | "wrong"; attemptsLeft?: number; retryAfterSeconds?: number }

/**
 * What a code attempt means. `matches` is the constant-time compare of the typed code against the
 * stored hash. A refused attempt (taken = false) is never compared at all.
 */
export function judgeAttempt(row: CountedAttempt | null, matches: boolean, now: Date): AttemptJudgement {
  if (!row) return { ok: false, reason: "not_found" }
  const lockedFor = row.lockedUntil && row.lockedUntil.getTime() > now.getTime() ? Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000) : 0
  if (!row.taken) {
    if (row.status !== "pending") return { ok: false, reason: "not_found" }
    if (lockedFor > 0 || row.attempts >= LOGIN_EMAIL_CHANGE.maxCodeAttempts) return { ok: false, reason: "locked", retryAfterSeconds: lockedFor || undefined }
    if (!row.codeExpiresAt || row.codeExpiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" }
    return { ok: false, reason: "not_found" }
  }
  if (matches) return { ok: true }
  const attemptsLeft = Math.max(0, LOGIN_EMAIL_CHANGE.maxCodeAttempts - row.attempts)
  if (attemptsLeft === 0) return { ok: false, reason: "locked", retryAfterSeconds: lockedFor || Math.ceil(LOGIN_EMAIL_CHANGE.lockMs / 1000) }
  return { ok: false, reason: "wrong", attemptsLeft }
}

/** Seconds until a new code may be asked for (0 = now). */
export function resendWaitSeconds(codeSentAt: Date, now: Date): number {
  const left = codeSentAt.getTime() + LOGIN_EMAIL_CHANGE.resendAfterMs - now.getTime()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/**
 * Step 1 limits, from the rows kept for this login (last hour): started changes, and any lock a
 * wrong-code run left behind. The password limit is NOT here: it is counted by writing the attempt
 * first and counting after (see countsAsPasswordAttempt), so parallel guesses cannot slip past.
 */
export function checkStartAllowed(input: {
  startTimes: Date[]
  lockedUntils: Date[]
  now: Date
}): { ok: true } | { ok: false; reason: "locked" | "too_many_starts"; retryAfterSeconds: number } {
  const { now } = input
  const lockedUntil = input.lockedUntils.filter((d) => d.getTime() > now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0]
  if (lockedUntil) return { ok: false, reason: "locked", retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)) }
  const from = now.getTime() - LOGIN_EMAIL_CHANGE.startWindowMs
  const recent = input.startTimes.filter((d) => d.getTime() > from).sort((a, b) => a.getTime() - b.getTime())
  if (recent.length >= LOGIN_EMAIL_CHANGE.maxStartsPerWindow) {
    const until = recent[recent.length - LOGIN_EMAIL_CHANGE.maxStartsPerWindow].getTime() + LOGIN_EMAIL_CHANGE.startWindowMs
    return { ok: false, reason: "too_many_starts", retryAfterSeconds: Math.max(1, Math.ceil((until - now.getTime()) / 1000)) }
  }
  return { ok: true }
}

/** Statuses that count as a password attempt at step 1. */
export function countsAsPasswordAttempt(status: string): boolean {
  return status === "password_check" || status === "password_failed"
}

/** After the attempt was written: is this attempt (counted together with the others in the window) allowed to be judged? */
export function passwordAttemptAllowed(attemptsInWindowIncludingThis: number): boolean {
  return attemptsInWindowIncludingThis <= LOGIN_EMAIL_CHANGE.maxPasswordAttempts
}

/** Can the "This wasn't me" link still be used? */
export type UndoCheck = { ok: true } | { ok: false; reason: "unknown" | "used" | "expired" | "superseded" }

export function checkUndo(input: {
  status: string
  undoExpiresAt: Date | null
  /** The login's email right now, and the email this change moved it to. */
  currentLoginEmail: string
  changedTo: string
  now: Date
}): UndoCheck {
  if (input.status === "undone") return { ok: false, reason: "used" }
  if (input.status !== "confirmed") return { ok: false, reason: "unknown" }
  if (!input.undoExpiresAt || input.undoExpiresAt.getTime() <= input.now.getTime()) return { ok: false, reason: "expired" }
  // If the login has moved again since this change, putting THIS change's old email back would be wrong.
  if (normalizeEmail(input.currentLoginEmail) !== normalizeEmail(input.changedTo)) return { ok: false, reason: "superseded" }
  return { ok: true }
}

/** Password rule on the undo page (the same minimum as the change-password route). */
export function passwordProblem(password: unknown, repeat: unknown): "short" | "mismatch" | null {
  const p = typeof password === "string" ? password : ""
  if (p.length < LOGIN_EMAIL_CHANGE.minPasswordLength) return "short"
  if (p !== repeat) return "mismatch"
  return null
}

/** The contact's alternate emails with `email` added once (case-insensitive), or the same list when it is already there. */
export function withAltEmail(current: readonly string[] | null | undefined, email: string): string[] {
  const list = (current ?? []).filter((e) => typeof e === "string" && e.trim())
  const key = normalizeEmail(email)
  if (!key || list.some((e) => normalizeEmail(e) === key)) return [...list]
  return [...list, key]
}

/** The same list with `email` taken out (case-insensitive). */
export function withoutAltEmail(current: readonly string[] | null | undefined, email: string): string[] {
  const key = normalizeEmail(email)
  return (current ?? []).filter((e) => typeof e === "string" && e.trim() && normalizeEmail(e) !== key)
}
