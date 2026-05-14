'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SDCard {
  id: string
  accountId: string
  companyName: string
  daysAtStage: number | null
}

export interface StageColumn {
  stageName: string
  slaDays: number | null
  cards: SDCard[]
}

export interface ServiceGroup {
  serviceType: string
  trackerSlug: string | null
  totalActive: number
  stages: StageColumn[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Cards older than slaDays are red; 80% of sla = amber; else green.
// When no SLA defined: ≥30d = red, ≥7d = amber, else green.
function daysColor(days: number | null, slaDays: number | null): string {
  if (days === null) return 'bg-zinc-100 text-zinc-500'
  const red = slaDays ?? 30
  const amber = slaDays ? Math.round(slaDays * 0.8) : 7
  if (days >= red) return 'bg-red-100 text-red-700'
  if (days >= amber) return 'bg-amber-100 text-amber-700'
  return 'bg-emerald-100 text-emerald-700'
}

const CARDS_PER_STAGE = 5

// ─── Card ────────────────────────────────────────────────────────────────────

function SDCardItem({ card, slaDays }: { card: SDCard; slaDays: number | null }) {
  const color = daysColor(card.daysAtStage, slaDays)
  return (
    <Link
      href={card.accountId ? `/accounts/${card.accountId}?tab=activity` : '#'}
      className="block rounded-md border bg-white px-2.5 py-2 hover:shadow-sm transition-shadow"
    >
      <p className="text-xs font-medium text-zinc-800 truncate leading-snug">
        {card.companyName}
      </p>
      {card.daysAtStage !== null && (
        <span className={cn('mt-1 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded', color)}>
          {card.daysAtStage}d
        </span>
      )}
    </Link>
  )
}

// ─── Stage column ─────────────────────────────────────────────────────────────

function StageCol({ col }: { col: StageColumn }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? col.cards : col.cards.slice(0, CARDS_PER_STAGE)
  const hasMore = col.cards.length > CARDS_PER_STAGE

  return (
    <div className="flex-shrink-0 w-44">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-700 truncate max-w-[120px]" title={col.stageName}>
          {col.stageName}
        </span>
        <span className="ml-1 text-[10px] bg-zinc-100 text-zinc-500 rounded-full px-1.5 py-0.5 font-medium shrink-0">
          {col.cards.length}
        </span>
      </div>
      <div className="space-y-1.5">
        {shown.map(card => (
          <SDCardItem key={card.id} card={card} slaDays={col.slaDays} />
        ))}
        {col.cards.length === 0 && (
          <p className="text-[11px] text-zinc-400 py-2 text-center">—</p>
        )}
        {hasMore && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-full text-[10px] text-muted-foreground hover:text-foreground py-1 transition-colors"
          >
            {expanded ? 'Show less' : `+${col.cards.length - CARDS_PER_STAGE} more`}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Service group row ────────────────────────────────────────────────────────

function ServiceGroupRow({ group }: { group: ServiceGroup }) {
  const [open, setOpen] = useState(true)

  // Summary: stage with most cards that are in alert state
  const redCount = group.stages.reduce(
    (n, s) => n + s.cards.filter(c => c.daysAtStage !== null && c.daysAtStage >= (s.slaDays ?? 30)).length,
    0,
  )

  return (
    <div className="border rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-50 hover:bg-zinc-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
          <span className="text-sm font-semibold text-zinc-800">{group.serviceType}</span>
          <span className="text-xs text-zinc-500">{group.totalActive} active</span>
          {redCount > 0 && (
            <span className="text-[10px] font-medium bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">
              {redCount} overdue
            </span>
          )}
        </div>
        {group.trackerSlug && (
          <Link
            href={`/trackers/${group.trackerSlug}`}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Full tracker <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </button>

      {/* Stage columns */}
      {open && (
        <div className="px-4 py-3 overflow-x-auto">
          <div className="flex gap-3" style={{ minWidth: `${group.stages.length * 188}px` }}>
            {group.stages.map(col => (
              <StageCol key={col.stageName} col={col} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function JourneyBoard({ groups }: { groups: ServiceGroup[] }) {
  const [filter, setFilter] = useState<string | null>(null)

  const shown = filter ? groups.filter(g => g.serviceType === filter) : groups

  const totalActive = groups.reduce((n, g) => n + g.totalActive, 0)

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground py-12 text-center">No active service deliveries found.</p>
  }

  return (
    <div className="space-y-4">
      {/* Summary + filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground mr-1">{totalActive} active across all pipelines</span>
        <button
          onClick={() => setFilter(null)}
          className={cn(
            'text-xs px-2.5 py-1 rounded-full border font-medium transition-colors',
            filter === null
              ? 'bg-zinc-900 text-white border-zinc-900'
              : 'bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100',
          )}
        >
          All
        </button>
        {groups.map(g => (
          <button
            key={g.serviceType}
            onClick={() => setFilter(filter === g.serviceType ? null : g.serviceType)}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full border font-medium transition-colors',
              filter === g.serviceType
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100',
            )}
          >
            {g.serviceType} ({g.totalActive})
          </button>
        ))}
      </div>

      {/* Groups */}
      <div className="space-y-3">
        {shown.map(group => (
          <ServiceGroupRow key={group.serviceType} group={group} />
        ))}
      </div>
    </div>
  )
}
