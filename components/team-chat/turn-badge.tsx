'use client'

import { Check, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ThreadReadState } from '@/lib/team/thread-turn'

/**
 * The per-thread "whose turn is it" read receipt, shown on every surface that
 * lists a thread (channel panel, in-stream replies line, board card, Later list)
 * so the signal reads the same everywhere. State is computed server-side
 * (lib/team/thread-turn); this only renders it. Renders nothing for 'none'.
 */
export function TurnBadge({
  state,
  name,
  className,
}: {
  state?: ThreadReadState | null
  name?: string | null
  className?: string
}) {
  if (!state || state === 'none') return null

  const shell = 'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border whitespace-nowrap'

  if (state === 'waiting_you') {
    return (
      <span className={cn(shell, 'bg-amber-50 text-amber-700 border-amber-200', className)}>
        <Eye className="h-2.5 w-2.5" />waiting for you
      </span>
    )
  }
  if (state === 'waiting_them') {
    return (
      <span className={cn(shell, 'bg-zinc-100 text-zinc-500 border-zinc-200', className)}>
        sent · waiting for {name || 'them'}
      </span>
    )
  }
  // seen
  return (
    <span className={cn(shell, 'bg-emerald-50 text-emerald-700 border-emerald-200', className)}>
      <Check className="h-2.5 w-2.5" />seen
    </span>
  )
}
