'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Briefcase,
  CheckSquare,
  CreditCard,
  File,
  Loader2,
  MessageCircle,
  RefreshCw,
  Settings,
  Wand2,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  fetchAccountActivity,
  fetchContactActivity,
} from '@/app/(dashboard)/shared/account-activity-action'
import type { ActivityEvent, ActivityEventType } from '@/lib/operations/account-activity'


// ─── Types ───────────────────────────────────────────────────────────────────

type Props =
  | { kind: 'account'; accountId: string; contactIds?: string[] }
  | { kind: 'contact'; contactId: string; accountIds?: string[] }

// ─── Event metadata ──────────────────────────────────────────────────────────

const EVENT_META: Record<
  ActivityEventType,
  { label: string; icon: React.ElementType; dot: string; pill: string }
> = {
  offer: {
    label: 'Offers',
    icon: File,
    dot: 'bg-blue-500',
    pill: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
  },
  payment: {
    label: 'Payments',
    icon: CreditCard,
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
  },
  activation: {
    label: 'Activations',
    icon: Zap,
    dot: 'bg-violet-500',
    pill: 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100',
  },
  service: {
    label: 'Services',
    icon: Briefcase,
    dot: 'bg-indigo-500',
    pill: 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100',
  },
  wizard: {
    label: 'Wizards',
    icon: Wand2,
    dot: 'bg-purple-500',
    pill: 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100',
  },
  document: {
    label: 'Documents',
    icon: File,
    dot: 'bg-amber-500',
    pill: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
  },
  task: {
    label: 'Tasks',
    icon: CheckSquare,
    dot: 'bg-orange-500',
    pill: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
  },
  action: {
    label: 'CRM Actions',
    icon: Settings,
    dot: 'bg-zinc-400',
    pill: 'bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100',
  },
  message: {
    label: 'Messages',
    icon: MessageCircle,
    dot: 'bg-sky-500',
    pill: 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100',
  },
}

// Filter pills shown at the top — order determines display order
const FILTER_TYPES: ActivityEventType[] = [
  'offer',
  'activation',
  'payment',
  'service',
  'wizard',
  'document',
  'task',
  'message',
  'action',
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Event row ───────────────────────────────────────────────────────────────

function EventRow({ event }: { event: ActivityEvent }) {
  const meta = EVENT_META[event.type]
  const Icon = meta.icon

  return (
    <div className="flex items-start gap-3 py-2.5">
      {/* Dot + icon */}
      <div
        className={cn(
          'mt-0.5 w-7 h-7 rounded-full flex items-center justify-center shrink-0',
          meta.dot,
        )}
      >
        <Icon className="h-3.5 w-3.5 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-900 leading-snug">{event.title}</p>
        {event.body && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{event.body}</p>
        )}
      </div>

      {/* Timestamp */}
      <span
        className="text-xs text-muted-foreground whitespace-nowrap shrink-0 mt-0.5"
        title={exactTime(event.timestamp)}
      >
        {relativeTime(event.timestamp)}
      </span>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ActivityFeed(props: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<ActivityEventType | null>(null)
  const [visibleCount, setVisibleCount] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    if (props.kind === 'account') {
      const res = await fetchAccountActivity(props.accountId, props.contactIds)
      if (res.success) setEvents(res.events)
      else setError((res as { success: false; error: string }).error)
    } else {
      const res = await fetchContactActivity(props.contactId, props.accountIds)
      if (res.success) setEvents(res.events)
      else setError((res as { success: false; error: string }).error)
    }
    setLoading(false)
  }, [props])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load()
  }, [load])

  // Derive which filter pills have at least one event (show all pills always,
  // but grey out empty ones so the user knows what types exist)
  const typeHasEvents = new Set(events.map((e) => e.type))

  const filtered = activeFilter
    ? events.filter((e) => e.type === activeFilter)
    : events

  const visible = filtered.slice(0, visibleCount)
  const hasMore = filtered.length > visibleCount

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading activity…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header + refresh */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {events.length} event{events.length !== 1 ? 's' : ''} total
        </p>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => { setActiveFilter(null); setVisibleCount(50) }}
          className={cn(
            'text-xs px-2.5 py-1 rounded-full border font-medium transition-colors',
            activeFilter === null
              ? 'bg-zinc-900 text-white border-zinc-900'
              : 'bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100',
          )}
        >
          All ({events.length})
        </button>
        {FILTER_TYPES.map((type) => {
          const meta = EVENT_META[type]
          const count = events.filter((e) => e.type === type).length
          if (count === 0 && !typeHasEvents.has(type)) return null
          return (
            <button
              key={type}
              onClick={() => { setActiveFilter(activeFilter === type ? null : type); setVisibleCount(50) }}
              className={cn(
                'text-xs px-2.5 py-1 rounded-full border font-medium transition-colors',
                activeFilter === type
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : count > 0
                    ? meta.pill
                    : 'bg-zinc-50 text-zinc-400 border-zinc-200 opacity-40',
              )}
            >
              {meta.label} ({count})
            </button>
          )
        })}
      </div>

      {/* Timeline */}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No events found.</p>
      ) : (
        <div className="divide-y divide-zinc-100">
          {visible.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <button
          onClick={() => setVisibleCount((n) => n + 50)}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-2 border border-dashed rounded-md transition-colors"
        >
          Show more ({filtered.length - visibleCount} remaining)
        </button>
      )}
    </div>
  )
}
