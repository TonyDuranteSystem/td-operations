'use client'

/**
 * Watches the connection for the whole dashboard (also inside floating windows): fires the "reconnected" signal the screens
 * catch up on, and — in the main window only — shows a thin "Connection lost — reconnecting…" banner while it is down.
 */
import { WifiOff } from 'lucide-react'
import { useConnectionState } from '@/lib/hooks/use-connection-state'
import { useEmbedded } from '@/lib/embed/embedded-context'

export function ConnectionWatcher() {
  const { offline } = useConnectionState()
  const embedded = useEmbedded()
  if (!offline || embedded) return null
  return (
    <div role="status" aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex justify-center px-3 pt-2" data-testid="connection-lost-banner">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
        <WifiOff className="h-4 w-4" />
        Connection lost — reconnecting…
      </div>
    </div>
  )
}
