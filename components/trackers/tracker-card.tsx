'use client'

import { Clock, User, ClipboardList, CheckCircle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ServiceDelivery } from '@/lib/types'

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

  return (
    <div className={cn(
      'bg-white rounded-lg border p-3 transition-shadow cursor-grab',
      isDragging ? 'shadow-lg border-blue-300 rotate-1' : 'hover:shadow-sm',
    )}>
      {/* Company name */}
      <p className="text-sm font-medium text-zinc-900 truncate">
        {delivery.company_name ?? delivery.service_name}
      </p>

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

      {/* Complete button (only on last stage) */}
      {isLastStage && (
        <button
          onClick={(e) => { e.stopPropagation(); onComplete() }}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 transition-colors"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          Mark Complete
        </button>
      )}
    </div>
  )
}
