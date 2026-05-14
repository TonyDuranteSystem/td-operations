'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Briefcase,
  CreditCard,
  File,
  Loader2,
  RefreshCw,
  Wand2,
} from 'lucide-react'
import { fetchPortalJourney } from '@/app/portal/chat/actions'
import type { ActivityEvent, ActivityEventType } from '@/lib/operations/account-activity'

// ─── Event metadata (portal-visible types only) ───────────────────────────────

const EVENT_META: Record<ActivityEventType, { icon: React.ElementType; dot: string }> = {
  offer: { icon: File, dot: 'bg-blue-500' },
  payment: { icon: CreditCard, dot: 'bg-emerald-500' },
  activation: { icon: File, dot: 'bg-violet-500' },
  service: { icon: Briefcase, dot: 'bg-indigo-500' },
  wizard: { icon: Wand2, dot: 'bg-purple-500' },
  document: { icon: File, dot: 'bg-amber-500' },
  task: { icon: File, dot: 'bg-orange-500' },
  action: { icon: File, dot: 'bg-zinc-400' },
  message: { icon: File, dot: 'bg-sky-500' },
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

function exactTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function EventRow({ event }: { event: ActivityEvent }) {
  const meta = EVENT_META[event.type] ?? EVENT_META.offer
  const Icon = meta.icon

  return (
    <div className="flex items-start gap-3 py-3">
      <div className={`mt-0.5 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${meta.dot}`}>
        <Icon className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-900 leading-snug">{event.title}</p>
        {event.body && (
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{event.body}</p>
        )}
      </div>
      <span
        className="text-xs text-zinc-400 whitespace-nowrap shrink-0 mt-0.5"
        title={exactTime(event.timestamp)}
      >
        {relativeTime(event.timestamp)}
      </span>
    </div>
  )
}

export function LogTab() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await fetchPortalJourney()
    if (res.success) setEvents(res.events)
    else setError((res as { success: false; error: string }).error)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-400 gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading your journey…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <p className="text-sm text-red-500">{error}</p>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-700 transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-zinc-400">No journey events yet.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-zinc-400">{events.length} event{events.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-700 transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      <div className="divide-y divide-zinc-100">
        {events.map(event => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  )
}
