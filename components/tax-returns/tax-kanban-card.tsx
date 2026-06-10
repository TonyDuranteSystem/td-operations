'use client'

import Link from 'next/link'
import { Building2, Clock, CheckCircle2, CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { daysInStage, stalenessLevel, type BoardCard } from '@/lib/tax/tax-board'

const STALE_STYLE: Record<string, string> = {
  fresh: 'text-emerald-600',
  warn: 'text-amber-600',
  stale: 'text-red-600 font-semibold',
}

/**
 * One Tax Board card (Slice 6). Read-only; company name links to the account
 * detail page where staff manage the client. `staleDays` is the card's column
 * threshold (drives the days-in-stage traffic light). `nowIso` is passed from
 * the server render so the day math is deterministic and SSR-stable.
 */
export function TaxKanbanCard({
  card,
  staleDays,
  nowIso,
  onSelect,
}: {
  card: BoardCard
  staleDays: number | null
  nowIso: string
  onSelect?: (card: BoardCard) => void
}) {
  const days = daysInStage(card.stageEnteredAt, new Date(nowIso))
  const level = stalenessLevel(days, staleDays)

  return (
    <div
      onClick={() => onSelect?.(card)}
      className="cursor-pointer rounded-lg border bg-white p-3 shadow-sm hover:shadow transition-shadow"
    >
      <div className="flex items-start justify-between gap-2">
        {card.accountId ? (
          <Link
            href={`/accounts/${card.accountId}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800 hover:text-blue-600 hover:underline"
          >
            <Building2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="truncate">{card.companyName ?? 'Unknown company'}</span>
          </Link>
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800">
            <Building2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="truncate">{card.companyName ?? 'Unknown company'}</span>
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {card.returnType && (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700">
            {card.returnType}
          </span>
        )}
        {card.taxYear && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600">
            TY {card.taxYear}
          </span>
        )}
        {card.entityType && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">{card.entityType}</span>
        )}
        {card.extensionFiled && (
          <span className="rounded bg-purple-50 px-1.5 py-0.5 font-medium text-purple-700">Ext</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span
          className={cn(
            'flex items-center gap-1 font-medium',
            card.paid ? 'text-emerald-600' : 'text-zinc-400',
          )}
        >
          {card.paid ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <CircleDashed className="h-3 w-3" />
          )}
          {card.paid ? 'Paid' : 'Unpaid'}
        </span>
        <span className={cn('flex items-center gap-1', STALE_STYLE[level])}>
          <Clock className="h-3 w-3" />
          {days === null ? '—' : `${days}d`}
        </span>
      </div>

      {card.assignedTo && (
        <p className="mt-1.5 text-[10px] text-zinc-400">@{card.assignedTo}</p>
      )}
    </div>
  )
}
