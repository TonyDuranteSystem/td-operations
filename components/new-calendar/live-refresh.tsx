'use client'

/**
 * New Calendar — keeps the page current without a hard refresh (Antonio 2026-10-16). Renders nothing.
 *  1. A job change (a step moved, a job finished, a new job) arrives as the dashboard's `td-ui-event` of kind `jobs`; the page refreshes
 *     ONCE, about a second later, however many changes came together (lib/new-calendar/live.ts).
 *  2. Safety net: while the tab is visible it also refreshes every minute, and when you come back to the tab after being away — so a dropped
 *     connection, or a change made before the database trigger exists, never leaves the list stale for long.
 * A refresh re-reads the server page only; what you typed in the search box and the list you chose stay as they are.
 */

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { LIVE_POLL_MS, isJobsEvent, refreshDelay } from '@/lib/new-calendar/live'

const AWAY_MS = 30_000

export function LiveRefresh() {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstSignalRef = useRef<number | null>(null)
  const routerRef = useRef(router)
  routerRef.current = router

  useEffect(() => {
    const refreshNow = () => {
      timerRef.current = null
      firstSignalRef.current = null
      routerRef.current.refresh()
    }
    const onEvent = (e: Event) => {
      if (!isJobsEvent((e as CustomEvent).detail)) return
      const now = Date.now()
      if (timerRef.current) clearTimeout(timerRef.current)
      else firstSignalRef.current = now
      timerRef.current = setTimeout(refreshNow, refreshDelay(now, firstSignalRef.current))
    }
    document.addEventListener('td-ui-event', onEvent)

    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') routerRef.current.refresh()
    }, LIVE_POLL_MS)

    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
      } else if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) {
        hiddenAt = 0
        routerRef.current.refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('td-ui-event', onEvent)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(poll)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return null
}
