'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Global in-app Back — rendered on every dashboard page, in BOTH the desktop
 * header and the mobile app bar. It matters most in the installed phone app (a
 * PWA has no browser back button), which is why Antonio asked for it everywhere.
 *
 * Goes to the previous page you were on (Next.js App Router restores scroll on
 * back). GUARDED so a fresh open / deep link doesn't call back() into nothing and
 * leave the app: we only call router.back() once the user has actually navigated
 * within the app this session; otherwise we go home ('/').
 *
 * ⚠️ We do NOT read window.history.state.idx — the Next.js App Router does NOT
 * populate it (verified 2026-07-26: history.state is
 * {__NA, __PRIVATE_NEXTJS_INTERNALS_TREE}, no idx), so the old idx guard was
 * always falsy and every Back went home. We track navigation via pathname
 * changes instead, in a module-scoped flag so it survives remounts and is shared
 * by the desktop + mobile instances.
 *
 * NOTE: this steps back a PAGE. Surfaces that drill in WITHOUT changing the URL
 * (a thread inside team chat, a conversation inside portal chats) carry their own
 * in-surface back controls; the two together always let you step back.
 */
let hasNavigatedInApp = false

export function GlobalBackButton({ className }: { className?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const mounted = useRef(false)

  useEffect(() => {
    // Skip the initial mount; any later pathname change is a real in-app move.
    if (mounted.current) hasNavigatedInApp = true
    else mounted.current = true
  }, [pathname])

  const onBack = () => {
    if (hasNavigatedInApp) router.back()
    else router.push('/')
  }

  return (
    <button
      onClick={onBack}
      title="Back"
      aria-label="Back"
      className={cn('p-2 rounded-md hover:bg-zinc-100 text-zinc-500 transition-colors', className)}
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  )
}
