'use client'

import { useEffect, useRef, useState } from 'react'
import { OWN_RELEASE_ID } from '@/lib/release/own-release'
import {
  INITIAL_RELEASE_STATE,
  RELEASE_CONFIRM_MS,
  RELEASE_POLL_MS,
  nextReleaseState,
  type ReleaseState,
} from '@/lib/release/release-check'

/**
 * Is a newer release live than the one this page was loaded with? (dev job dc629a3d; rules in lib/release/release-check.ts.)
 *
 * Asks /api/release every minute while the tab is visible, and again the moment you come back to it. A first different answer is
 * only a suspicion: it is re-asked a few seconds later, and only the same different answer twice in a row shows the banner.
 * Any failure (offline, logged out, a redirect to the login page, a damaged answer) is ignored — never a false alarm.
 * `enabled` false (the client portal, which still uses the worker-only bar) or a build with no release id → does nothing.
 */
export function useReleaseCheck(enabled: boolean): { show: boolean; live: string | null } {
  const [view, setView] = useState<{ show: boolean; live: string | null }>({ show: false, live: null })
  const state = useRef<ReleaseState>(INITIAL_RELEASE_STATE)

  useEffect(() => {
    if (!enabled || !OWN_RELEASE_ID) return
    let alive = true
    let busy = false
    let confirm: ReturnType<typeof setTimeout> | null = null

    const check = async () => {
      if (!alive || busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        // redirect: 'manual' — a session that ended answers with a redirect to the login page; that must read as "no answer", not as a page.
        const res = await fetch('/api/release', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' })
        if (!res.ok) return
        const data = (await res.json()) as { version?: unknown }
        const next = nextReleaseState(state.current, OWN_RELEASE_ID, data.version)
        state.current = next
        if (alive) setView(prev => (prev.show === next.show && prev.live === next.different ? prev : { show: next.show, live: next.different }))
        if (confirm) { clearTimeout(confirm); confirm = null }
        if (alive && next.different && !next.show) confirm = setTimeout(() => { confirm = null; void check() }, RELEASE_CONFIRM_MS)
      } catch {
        /* offline or a damaged answer: try again at the next tick */
      } finally {
        busy = false
      }
    }

    void check()
    const timer = setInterval(() => { void check() }, RELEASE_POLL_MS)
    const wake = () => { void check() }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      alive = false
      clearInterval(timer)
      if (confirm) clearTimeout(confirm)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [enabled])

  return view
}
