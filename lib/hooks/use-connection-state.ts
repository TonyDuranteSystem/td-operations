'use client'

import { useEffect, useState } from 'react'
import { ConnectionTracker } from '@/lib/hooks/connection-tracker'

/**
 * Fired on `window` every time the browser comes back online after a drop — however short. Screens that load their own data
 * (the Storage browser, the live-update bus) listen to it and catch up, so nobody has to refresh by hand.
 * See `connection-tracker.ts` for why it is separate from the 20-second "wake" signal.
 */
export const RECONNECTED_EVENT = 'td-reconnected'

/** Run `handler` whenever the connection comes back. Returns the unsubscribe function. */
export function onReconnected(handler: () => void): () => void {
  window.addEventListener(RECONNECTED_EVENT, handler)
  return () => window.removeEventListener(RECONNECTED_EVENT, handler)
}

/** true while the connection has been down long enough to show the "Connection lost" banner. Mount once per page. */
export function useConnectionState(): { offline: boolean } {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const tracker = new ConnectionTracker({
      showOffline: () => setOffline(true),
      hideOffline: () => setOffline(false),
      reconnected: () => window.dispatchEvent(new CustomEvent(RECONNECTED_EVENT)),
    })
    const goOffline = () => tracker.goOffline()
    const goOnline = () => tracker.goOnline()
    if (typeof navigator !== 'undefined' && navigator.onLine === false) tracker.goOffline()
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
      tracker.dispose()
    }
  }, [])
  return { offline }
}
