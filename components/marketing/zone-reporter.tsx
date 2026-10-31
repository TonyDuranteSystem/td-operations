'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Tells the server which time zone this browser is in, so that every time on the screens follows where the person connects from (Antonio, 31 Oct 2026). It asks when a Marketing screen opens
 * and again when the tab comes back to the front (a laptop that woke up in another country); it sends only when the zone differs from the one the server already holds, and refreshes the
 * screen when the server took it. Nothing is shown and a failure is silent: the next visit asks again.
 */
export function ZoneReporter({ knownZone }: { knownZone: string }) {
  const router = useRouter()
  useEffect(() => {
    let sent = ''
    const check = async () => {
      let z = ''
      try { z = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return }
      if (!z || z === knownZone || z === sent) return
      sent = z
      try {
        const res = await fetch('/api/marketing/my-zone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: z }) })
        const d = await res.json().catch(() => ({})) as { changed?: boolean }
        if (res.ok && d.changed) router.refresh()
      } catch { /* the next visit asks again */ }
    }
    void check()
    const back = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [knownZone, router])
  return null
}
