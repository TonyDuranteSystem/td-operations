/**
 * The App Store review practice login (TD Social, Antonio's word 6 Nov 2026) — ONE pure module that owns the flag, so the sign-in gate
 * (lib/auth/mfa-gate.ts) and the Marketing guard (lib/marketing/guard.ts) can never read it two different ways.
 *
 * `app_metadata.review_demo_until` is an ISO date written ONLY with the service role. Three states:
 *  - 'none'   — no flag (absent, null, empty): an ordinary login, nothing changes.
 *  - 'live'   — now is inside a window (`review_demo_from` -> `review_demo_until`) that is at most REVIEW_DEMO_MAX_DAYS long: the login may sign in with its password alone (gate) and is capped (guard).
 *  - 'lapsed' — a flag is there but is not live (past, too far, not a date, any other value): the login is DEAD. The gate treats it as an ordinary strict login
 *               and the guard refuses every request, so an expired practice login cannot be revived by enrolling an authenticator.
 *
 * The flag is also BOUND to one team: `app_metadata.review_demo_team` must equal the team the login belongs to, or the guard refuses every request. The gate cannot
 * look at teams (no database in the middleware), so a flag put by mistake on a login of a REAL team lets that person past the second step but gives them nothing.
 */

export const REVIEW_DEMO_KEY = 'review_demo_until'

/** When the practice window STARTS (`app_metadata.review_demo_from`). Written together with the deadline: the window is bounded at WRITE time, so a mistyped far-future deadline can never switch itself on later. */
export const REVIEW_DEMO_FROM_KEY = 'review_demo_from'

/** The practice window (from -> until) may be at most this long. A longer one is never honoured: a typo such as the year 2099 must never become a long password-only login. */
export const REVIEW_DEMO_MAX_DAYS = 90

export type ReviewDemoState = 'none' | 'live' | 'lapsed'

const toMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/** Is `now` inside a real window that was written short enough? Anything else (missing, text, past, not started, too long) is NOT live: fails closed. */
export function reviewDemoLive(untilRaw: unknown, fromRaw: unknown, now: number): boolean {
  const until = toMs(untilRaw), from = toMs(fromRaw)
  if (until === null || from === null) return false
  return from <= now && now < until && until - from <= REVIEW_DEMO_MAX_DAYS * 86_400_000
}

/** The state of a login, from its `app_metadata` (the verified one: never `user_metadata`, which a person can edit). */
export function reviewDemoState(appMetadata: unknown, now: number): ReviewDemoState {
  const meta = appMetadata as Record<string, unknown> | null | undefined
  const raw = meta?.[REVIEW_DEMO_KEY]
  if (raw === undefined || raw === null) return 'none'
  if (typeof raw === 'string' && raw.trim().length === 0) return 'none'
  return reviewDemoLive(raw, meta?.[REVIEW_DEMO_FROM_KEY], now) ? 'live' : 'lapsed'
}

/** The id of the one team the practice login is tied to (`app_metadata.review_demo_team`), or null. */
export const REVIEW_DEMO_TEAM_KEY = 'review_demo_team'

/** Everything the guard needs to know about the flag. */
export interface ReviewDemoFlag { state: ReviewDemoState; team: string | null }

/** An ordinary login: no flag. Callers with no session (alerts, badges, the admin paths) pass this out loud. */
export const NO_REVIEW_DEMO: ReviewDemoFlag = { state: 'none', team: null }

export function reviewDemoFlag(appMetadata: unknown, now: number): ReviewDemoFlag {
  const team = (appMetadata as Record<string, unknown> | null | undefined)?.[REVIEW_DEMO_TEAM_KEY]
  return { state: reviewDemoState(appMetadata, now), team: typeof team === 'string' && team.length > 0 ? team : null }
}
