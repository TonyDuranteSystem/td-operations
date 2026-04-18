'use client'

import { useState } from 'react'
import { Clock, User, ClipboardList, CheckCircle, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ServiceDelivery } from '@/lib/types'
import { StageHistoryDialog } from './stage-history-dialog'
import { DeliveryRowActions } from './delivery-row-actions'

interface TrackerCardProps {
  delivery: ServiceDelivery
  isDragging: boolean
  isLastStage: boolean
  onComplete: () => void
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

export function TrackerCard({ delivery, isDragging, isLastStage, onComplete }: TrackerCardProps) {
  const stageTime = timeAgo(delivery.stage_entered_at)
  const hasOpenTasks = (delivery.open_task_count ?? 0) > 0
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div className={cn(
      'bg-white rounded-lg border p-3 transition-shadow cursor-grab',
      isDragging ? 'shadow-lg border-blue-300 rotate-1' : 'hover:shadow-sm',
    )}>
      {/* Company name + row actions */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-zinc-900 truncate flex-1">
          {delivery.company_name ?? delivery.service_name}
        </p>
        <div className="-mr-1 -mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <DeliveryRowActions delivery={{
            id: delivery.id,
            service_name: delivery.service_name ?? null,
            service_type: delivery.service_type ?? null,
            status: delivery.status ?? null,
            stage: delivery.stage ?? null,
            assigned_to: delivery.assigned_to ?? null,
            notes: delivery.notes ?? null,
            updated_at: delivery.updated_at,
          }} />
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
        {stageTime && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {stageTime}
          </span>
        )}
        {delivery.assigned_to && (
          <span className="flex items-center gap-1">
            <User className="h-3 w-3" />
            {delivery.assigned_to}
          </span>
        )}
      </div>

      {/* Tasks summary */}
      {(delivery.task_count ?? 0) > 0 && (
        <div className="mt-2 flex items-center gap-1.5">
          <ClipboardList className="h-3 w-3 text-zinc-400" />
          <span className={cn(
            'text-xs',
            hasOpenTasks ? 'text-amber-600 font-medium' : 'text-zinc-400'
          )}>
            {delivery.open_task_count} open / {delivery.task_count} tasks
          </span>
        </div>
      )}

      {/* Notes preview */}
      {delivery.notes && (
        <p className="mt-2 text-xs text-zinc-400 truncate">{delivery.notes}</p>
      )}

      {/* Action row */}
      <div className="mt-2 flex items-center gap-3">
        {isLastStage && (
          <button
            onClick={(e) => { e.stopPropagation(); onComplete() }}
            className="flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 transition-colors"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Mark Complete
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setShowHistory(true) }}
          onMouseDown={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 transition-colors"
          title="View stage transition history"
        >
          <History className="h-3.5 w-3.5" />
          History
        </button>
      </div>

      <StageHistoryDialog
        open={showHistory}
        onClose={() => setShowHistory(false)}
        deliveryId={delivery.id}
        deliveryLabel={delivery.company_name ?? delivery.service_name ?? 'Service delivery'}
      />
    </div>
  )
}
