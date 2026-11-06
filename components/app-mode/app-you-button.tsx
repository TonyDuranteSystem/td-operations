'use client'

// The round "You" button of the TD Social phone app (approved mockup: the initials circle sits inside the top bar of each list screen).
// It exists only inside the app, and only on app versions that can open the "You" screen from a page (0.2.0+, see lib/app-mode/app-version.ts);
// older builds draw their own strip and this renders nothing. Tapping it asks the app to open its "You" screen (name, alert switches, sign out).
import { useEffect, useState } from 'react'
import { useAppMode } from '@/lib/app-mode/app-mode-context'
import { appHasYouBridge, initialsOf } from '@/lib/app-mode/app-version'

interface WebkitBridge { webkit?: { messageHandlers?: { tdsocial?: { postMessage: (m: string) => void } } } }

let meOnce: Promise<string> | null = null
function loadInitials(): Promise<string> {
  if (!meOnce) {
    meOnce = fetch('/api/marketing/app/me', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { user?: { name?: string | null; email?: string | null } } | null) => initialsOf(d?.user?.name, d?.user?.email))
      .catch(() => '?')
  }
  return meOnce
}

/** true once we know this is the phone app AND its version has the "You" message (decided after the page wakes up, so the server and the first paint agree) */
export function useYouBridge(): boolean {
  const appMode = useAppMode()
  const [yes, setYes] = useState(false)
  useEffect(() => { if (appMode && appHasYouBridge(navigator.userAgent)) setYes(true) }, [appMode])
  return yes
}

export function AppYouButton({ className = '' }: { className?: string }) {
  const has = useYouBridge()
  const [initials, setInitials] = useState('')
  useEffect(() => {
    if (!has) return
    let live = true
    void loadInitials().then(v => { if (live) setInitials(v) })
    return () => { live = false }
  }, [has])
  if (!has) return null
  return (
    <button
      type="button"
      aria-label="You"
      onClick={() => (window as unknown as WebkitBridge).webkit?.messageHandlers?.tdsocial?.postMessage('you')}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#C70F2E] text-sm font-semibold text-white ${className}`}
    >
      {initials || '·'}
    </button>
  )
}

/** The top bar of the Inbox and WhatsApp list screens in the app: the screen's name and the round "You" button. Nothing on older app builds. */
export function AppListTitle({ title }: { title: string }) {
  const has = useYouBridge()
  if (!has) return null
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b bg-white px-4" data-testid="app-list-title">
      <h1 className="text-lg font-semibold text-zinc-900">{title}</h1>
      <AppYouButton />
    </div>
  )
}
