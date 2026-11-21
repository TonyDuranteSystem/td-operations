/**
 * Guessing protection for the team-login username sign-in (the "Email or username" box with no @).
 *
 * What was wrong (bug hunt, 20 Nov 2026):
 *   - The lockout was keyed on the string the person TYPED, while the username lookup ran as a pattern search whose `*` means "anything":
 *     `marco.rossi*`, `*arco.rossi`, `m*rco.rossi` … each found the same login but each was a brand-new key with 5 fresh tries.
 *   - A failure was counted only AFTER the slow steps (the lookup and the password check), so a burst of parallel guesses all passed the
 *     "are they locked?" check before the first failure was written.
 *
 * Now: a username is ONE exact form (letters, digits, dot, dash, underscore, 3–30; lower-cased); anything else is refused without touching
 * the database and shares one counter; every attempt is COUNTED FIRST (and refunded when it succeeds); and on top of the per-address
 * counter there is a per-address total and a per-login total across all addresses.
 *
 * PURE — no database, no Next.js. The flow that uses it is login-flow.ts.
 */

/** The username rule (3–30 characters: letters, numbers, dot, dash, underscore) — the same one an owner's new login must satisfy. */
const TEAM_USERNAME = /^[A-Za-z0-9._-]{3,30}$/

/** The ONE form a typed username is looked up in (trimmed, lower-case), or null when it cannot be a username at all (a star, a percent sign, a space …). */
export function canonicalTeamUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const t = input.trim()
  return TEAM_USERNAME.test(t) ? t.toLowerCase() : null
}

/** Failures allowed from ONE address, for ANY usernames, before that address is locked (15 minutes). */
export const IP_MAX_FAILURES = 30
/** Failures allowed against ONE login from ALL addresses together before that login is locked (15 minutes). */
export const ACCOUNT_MAX_FAILURES = 20

export function teamLoginKeys(ip: string, username: string | null, teamMemberId?: string): { ipKey: string; nameKey: string; accountKey: string | null } {
  return {
    ipKey: `teammate-login-ip:${ip}`,
    // every unusable input from one address shares ONE counter, so odd spellings never make a fresh one
    nameKey: `teammate-login:${ip}:${username ?? '(not-a-username)'}`,
    accountKey: teamMemberId ? `teammate-login-acct:${teamMemberId}` : null,
  }
}

export const INVALID_LOGIN_MESSAGE = 'Invalid username or password'

export function lockedLoginMessage(retryAfterSeconds: number | undefined): string {
  return `Too many failed attempts. Please try again in about ${Math.max(1, Math.ceil((retryAfterSeconds ?? 0) / 60))} minutes.`
}
