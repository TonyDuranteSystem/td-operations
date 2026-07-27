'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Global in-app Back — rendered on every dashboard page, in BOTH the desktop
 * header and the mobile app bar. It matters most in the installed phone app (a
 * PWA has no browser back button), which is why Antonio asked for it everywhere.
 *
 * Goes to the previous page you were on (Next.js App Router restores scroll on
 * back). GUARDED: on a fresh open / deep link there is no in-app history to pop,
 * and a bare router.back() there would leave the app entirely — so when the
 * history index is 0 we route home ('/') instead of exiting the PWA.
 *
 * NOTE: this steps back a PAGE. Surfaces that drill in WITHOUT changing the URL
 * (opening a thread inside team chat, a conversation inside portal chats) carry
 * their own in-surface back controls; the two together always let you step back.
 */
export function GlobalBackButton({ className }: { className?: string }) {
  const router = useRouter()
  const onBack = () => {
    let idx = 0
    try {
      const s = window.history.state as { idx?: number } | null
      idx = typeof s?.idx === 'number' ? s.idx : 0
    } catch { idx = 0 }
    if (idx > 0) router.back()
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
