'use client'

import { useEffect, useRef } from 'react'

/**
 * Fires `onWake` when the user comes back to the app after being away.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Antonio: "I want the entire portal to auto-refresh instantly... I don't have
 * to refresh the page to get the update." Screens were showing whatever they
 * held when he left, sometimes for hours.
 *
 * ── WHY IT IS ONE HOOK AND NOT FOUR COPIES ─────────────────────────────────
 * The repo already hand-rolled this shape twice — components/dashboard/
 * sticky-notes-layer.tsx and components/team-chat/floating-chat.tsx both listen
 * for visibilitychange + online and refetch. Neither throttles, and neither
 * handles bfcache. Adding two more copies would have made four, with the
 * bfcache fix landing in exactly one of them — the same drift that produced the
 * office-address bug (commit 3ec7f88b). Those two call sites should migrate here.
 *
 * ── THE FOUR SIGNALS, AND WHY EACH ─────────────────────────────────────────
 *  - visibilitychange→visible : the load-bearing one. An installed iOS PWA that
 *      resumes after hours fires THIS, not `focus`.
 *  - focus                    : desktop ⌘-Tab between apps. On macOS this does
 *      NOT change visibilityState, so without it the "I was in Gmail" case —
 *      Antonio's literal words — is missed entirely.
 *  - online                   : reconnect after a dead network.
 *  - pageshow(persisted)      : bfcache restore (same-tab back/forward). Fires
 *      alongside visibilitychange, which the throttle absorbs. NOTE: this does
 *      NOT cover the iOS PWA resume case — that is a normal resume and fires
 *      visibilitychange. Recorded because a previous draft claimed otherwise.
 *
 * ── THE TWO GUARDS, AND WHY BOTH ───────────────────────────────────────────
 * A wake is expensive (in the portal it re-renders the whole route server-side,
 * ~15 DB queries in the layout alone before the page's own). So:
 *  1. `awayMs` — only fire if the user was actually gone. Measured from the
 *     last time we saw them leave, NEVER from "we have no record", because a
 *     zero timestamp reads as "away since 1970" and would fire on every single
 *     desktop alt-tab. If we never saw them leave, they were never away.
 *  2. `throttleMs` — TRAILING edge. A leading-edge throttle (the pattern in
 *     ui-event-listener.tsx) DISCARDS everything after the first event in the
 *     window; used for realtime events that would silently drop messages. Here
 *     it also matters: several signals fire on one wake, and we want exactly
 *     one refresh, but never zero.
 */
export interface UseWakeSignalOptions {
  /** Runs when the user returns after being away. Keep it idempotent. */
  onWake: () => void
  /** Minimum time away before a return counts as a wake. Default 20s. */
  awayMs?: number
  /** Collapse signals arriving together into one call. Default 5s. */
  throttleMs?: number
  /** Set false to disable entirely (e.g. on a route that must never refresh). */
  enabled?: boolean
}

const DEFAULT_AWAY_MS = 20_000
const DEFAULT_THROTTLE_MS = 5_000

export function useWakeSignal({
  onWake,
  awayMs = DEFAULT_AWAY_MS,
  throttleMs = DEFAULT_THROTTLE_MS,
  enabled = true,
}: UseWakeSignalOptions) {
  // Ref so a consumer re-render never re-registers the DOM listeners.
  const onWakeRef = useRef(onWake)
  useEffect(() => { onWakeRef.current = onWake }, [onWake])

  useEffect(() => {
    if (!enabled) return

    // null = "we have never seen this user leave". Deliberately NOT 0: a 0
    // baseline makes `now - leftAt` enormous, so the away-gate would pass on
    // every alt-tab-in and we would re-render the world all day.
    let leftAt: number | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    let lastFiredAt = 0

    const fire = () => {
      lastFiredAt = Date.now()
      leftAt = null            // consumed — don't let one departure fire twice
      try {
        onWakeRef.current()
      } catch (err) {
        console.error('[wake] onWake threw:', err)
      }
    }

    const requestWake = () => {
      if (leftAt === null) return                    // never left ⇒ not a wake
      if (Date.now() - leftAt < awayMs) return       // a blink, not an absence
      const sinceLast = Date.now() - lastFiredAt
      if (sinceLast >= throttleMs) { fire(); return }
      // Inside the window: schedule the TRAILING call rather than dropping it.
      if (pendingTimer) return
      pendingTimer = setTimeout(() => { pendingTimer = null; fire() }, throttleMs - sinceLast)
    }

    const markLeft = () => { if (leftAt === null) leftAt = Date.now() }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') markLeft()
      else requestWake()
    }
    // `pagehide` is the reliable "leaving" signal on iOS, where a suspended app
    // may never emit visibilitychange→hidden.
    const onPageHide = () => markLeft()
    const onFocus = () => requestWake()
    const onBlur = () => markLeft()
    const onOnline = () => requestWake()
    const onOffline = () => markLeft()
    const onPageShow = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) { markLeft(); requestWake() }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      if (pendingTimer) clearTimeout(pendingTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [enabled, awayMs, throttleMs])
}

/**
 * Pure decision function behind the hook, exported so the RULES are unit-tested
 * without a DOM (this repo's vitest is node-only, no testing-library).
 *
 * Returns whether a return-to-app should count as a wake.
 */
export function shouldWake(opts: {
  leftAt: number | null
  now: number
  awayMs?: number
}): boolean {
  const { leftAt, now, awayMs = DEFAULT_AWAY_MS } = opts
  if (leftAt === null) return false      // never observed leaving ⇒ never away
  return now - leftAt >= awayMs
}

export const WAKE_DEFAULTS = { awayMs: DEFAULT_AWAY_MS, throttleMs: DEFAULT_THROTTLE_MS }
