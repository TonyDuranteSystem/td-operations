/**
 * "New release available — refresh" (dev job dc629a3d): the pure rules.
 *
 * WHY: the old update bar (components/shared/update-banner.tsx) only fired when the browser found a NEW service-worker file, and
 * public/dashboard-sw.js almost never changes (2 commits in 30 days while main changed 424 times), so for ordinary releases nothing
 * told staff to refresh. Here every deployment carries its own release id; an open page asks the live site which release is running
 * and compares it with the one it was loaded with. Different on two readings in a row → show the banner.
 *
 * Fail quiet, never wrong: a page with no release id (local dev, an unstamped build) never claims a release; an unreadable answer
 * changes nothing; a rollout in progress (old and new instances answering in turn) cannot flicker the banner on, because one
 * different reading is only a suspicion.
 */

/** How often an open, visible page asks which release is live. */
export const RELEASE_POLL_MS = 60_000
/** After a first different reading, ask again this soon to confirm it (so a returning tab does not wait a whole minute). */
export const RELEASE_CONFIRM_MS = 5_000

/**
 * One identifier per deployment, from the build's own stamp: the commit (`NEXT_PUBLIC_BUILD_SHA`) and, on the sandbox only, the deploy
 * time (`NEXT_PUBLIC_BUILD_TIME`, so two deploys of the same uncommitted checkout still differ). Empty = unknown ("local" counts as
 * unknown: it is what a machine without a stamp reports).
 */
export function releaseIdFrom(sha: string | null | undefined, time?: string | null): string {
  const s = (sha ?? '').trim()
  if (!s || s === 'local') return ''
  const t = (time ?? '').trim()
  return t ? `${s}@${t}` : s
}

export interface ReleaseState {
  /** The different release id seen on the last reading (null = the last readable reading matched, or none yet). */
  different: string | null
  /** The banner is showing. */
  show: boolean
}

export const INITIAL_RELEASE_STATE: ReleaseState = { different: null, show: false }

/**
 * Fold one answer from the live site into the state.
 * - `own` empty → cannot compare → nothing ever shows.
 * - `live` not a non-empty string (error, redirect to login, damaged answer) → no change at all.
 * - `live` equals `own` → all clear (also hides the banner if the live release went back to this page's own, e.g. a rollback).
 * - `live` differs → the FIRST such reading is only a suspicion; the same different id on the NEXT reading shows the banner.
 *   Once showing, it stays showing while the live release keeps differing, even if a newer release replaces the one first seen.
 */
export function nextReleaseState(prev: ReleaseState, own: string, live: unknown): ReleaseState {
  if (!own) return prev
  if (typeof live !== 'string') return prev
  const l = live.trim()
  if (!l) return prev
  if (l === own) return INITIAL_RELEASE_STATE
  return { different: l, show: prev.show || prev.different === l }
}
