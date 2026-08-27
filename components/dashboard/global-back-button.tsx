'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { markInAppNavigation, canGoBackInApp } from '@/lib/nav/in-app-history'
import { FastTooltip } from '@/components/ui/fast-tooltip'

/**
 * Global in-app Back — rendered on every dashboard page, in BOTH the desktop
 * header and the mobile app bar. It matters most in the installed phone app (a
 * PWA has no browser back button), which is why Antonio asked for it everywhere.
 *
 * Steps back to wherever you were: the previous page, OR the previous in-page
 * selection (the previous chat in Portal Chats), because those selections are
 * recorded as real history entries by `useSelectionHistory`. On a fresh load /
 * deep link there is nothing in-app to return to, so it goes home rather than
 * calling back() into nothing and leaving the app.
 *
 * The "is there anywhere to go back to" question is answered by the shared
 * counter in lib/nav/in-app-history — see the warning there for the two guards
 * that were tried and failed (history.state.idx, and pathname-only).
 */
export function GlobalBackButton({ className }: { className?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const mounted = useRef(false)

  useEffect(() => {
    // Skip the initial mount; any later pathname change is a real in-app move.
    // (Query-only moves are reported by useSelectionHistory instead.)
    if (mounted.current) markInAppNavigation()
    else mounted.current = true
  }, [pathname])

  const onBack = () => {
    if (canGoBackInApp()) router.back()
    else router.push('/')
  }

  return (
    <FastTooltip label="Back" align="left">
      <button
        onClick={onBack}
        aria-label="Back"
        className={cn('p-2 rounded-md hover:bg-zinc-100 text-zinc-500 transition-colors', className)}
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
    </FastTooltip>
  )
}
