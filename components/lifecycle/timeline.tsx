'use client'

import { useState } from 'react'
import {
  User, FileText, Mail, Pen, Zap, ClipboardList,
  Briefcase, CreditCard, ChevronDown, ChevronUp, Clock,
} from 'lucide-react'
import type { TimelineEvent, TimelineEventType, TimelineColor } from '@/lib/lifecycle-timeline'

// ── Icon mapping ──

const ICON_MAP: Record<TimelineEventType, typeof User> = {
  lead_created: User,
  lead_converted: User,
  call_completed: Clock,
  offer_created: FileText,
  offer_viewed: FileText,
  offer_superseded: FileText,
  email_sent: Mail,
  email_opened: Mail,
  contract_signed: Pen,
  activation_created: Zap,
  payment_confirmed: CreditCard,
  wizard_started: ClipboardList,
  wizard_progress: ClipboardList,
  wizard_completed: ClipboardList,
  sd_created: Briefcase,
  payment_recorded: CreditCard,
}

const COLOR_MAP: Record<TimelineColor, { dot: string; bg: string }> = {
  gray: { dot: 'bg-zinc-400', bg: 'bg-zinc-50 text-zinc-700' },
  blue: { dot: 'bg-blue-500', bg: 'bg-blue-50 text-blue-700' },
  green: { dot: 'bg-emerald-500', bg: 'bg-emerald-50 text-emerald-700' },
  amber: { dot: 'bg-amber-500', bg: 'bg-amber-50 text-amber-700' },
  purple: { dot: 'bg-violet-500', bg: 'bg-violet-50 text-violet-700' },
  indigo: { dot: 'bg-indigo-500', bg: 'bg-indigo-50 text-indigo-700' },
  emerald: { dot: 'bg-emerald-500', bg: 'bg-emerald-50 text-emerald-700' },
  sky: { dot: 'bg-sky-500', bg: 'bg-sky-50 text-sky-700' },
  red: { dot: 'bg-red-500', bg: 'bg-red-50 text-red-700' },
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// ── Component ──

interface LifecycleTimelineProps {
  events: TimelineEvent[]
  defaultOpen?: boolean
  title?: string
}

export function LifecycleTimeline({ events, defaultOpen = true, title = 'Lifecycle Timeline' }: LifecycleTimelineProps) {
  const [open, setOpen] = useState(defaultOpen)

  if (events.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs text-zinc-400">{events.length} events</span>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-zinc-400" /> : <ChevronDown className="h-4 w-4 text-zinc-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4">
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[11px] top-2 bottom-2 w-px bg-zinc-200" />

            <div className="space-y-0">
              {events.map((event, i) => {
                const Icon = ICON_MAP[event.type] || Clock
                const colors = COLOR_MAP[event.color] || COLOR_MAP.gray
                const prevDate = i > 0 ? formatDate(events[i - 1].date) : null
                const thisDate = formatDate(event.date)
                const showDate = thisDate !== prevDate

                return (
                  <div key={event.sourceId || `${event.type}-${i}`}>
                    {/* Date separator */}
                    {showDate && (
                      <div className="flex items-center gap-2 pt-3 pb-1 ml-7">
                        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">{thisDate}</span>
                      </div>
                    )}

                    {/* Event row */}
                    <div className="flex items-start gap-3 py-1.5 group">
                      {/* Dot */}
                      <div className={`relative z-10 mt-0.5 h-[22px] w-[22px] rounded-full flex items-center justify-center ${colors.dot} ring-2 ring-white`}>
                        <Icon className="h-3 w-3 text-white" />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium text-zinc-900">{event.title}</span>
                          <span className="text-[10px] text-zinc-400 shrink-0">{formatTime(event.date)}</span>
                        </div>
                        {event.detail && (
                          <p className="text-xs text-zinc-500 mt-0.5 truncate">{event.detail}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
