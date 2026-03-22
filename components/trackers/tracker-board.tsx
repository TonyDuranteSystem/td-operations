'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { ChevronRight, Clock, User, CheckCircle, ClipboardList, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { advanceDeliveryStage, completeDelivery } from '@/app/(dashboard)/trackers/[serviceType]/actions'
import type { TrackerColumn, ServiceDelivery } from '@/lib/types'
import { TrackerCard } from './tracker-card'

interface TrackerBoardProps {
  columns: TrackerColumn[]
  completedDeliveries: ServiceDelivery[]
  serviceType: string
  slug: string
}

export function TrackerBoard({ columns, completedDeliveries, serviceType, slug }: TrackerBoardProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showCompleted, setShowCompleted] = useState(false)

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination || result.source.droppableId === result.destination.droppableId) return

    const deliveryId = result.draggableId
    const targetColIdx = parseInt(result.destination.droppableId.replace('col-', ''))
    const targetStage = columns[targetColIdx]?.stage

    if (!targetStage) return

    startTransition(async () => {
      const res = await advanceDeliveryStage(
        deliveryId,
        targetStage.stage_name,
        targetStage.stage_order,
      )
      if (res.success) {
        toast.success(`Advanced to ${targetStage.stage_name}`)
        router.refresh()
      } else {
        toast.error(res.error ?? 'Failed to advance stage')
      }
    })
  }

  const handleComplete = (deliveryId: string) => {
    startTransition(async () => {
      const res = await completeDelivery(deliveryId)
      if (res.success) {
        toast.success('Service marked as completed')
        router.refresh()
      } else {
        toast.error(res.error ?? 'Failed to complete')
      }
    })
  }

  const totalActive = columns.reduce((sum, col) => sum + col.deliveries.length, 0)

  return (
    <div className="space-y-4">
      {/* Stage progress bar */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {columns.map((col, i) => (
          <div key={col.stage.id} className="flex items-center">
            <div className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap',
              col.deliveries.length > 0
                ? 'bg-blue-100 text-blue-700'
                : 'bg-zinc-100 text-zinc-500'
            )}>
              <span>{col.stage.stage_name}</span>
              {col.deliveries.length > 0 && (
                <span className="bg-blue-600 text-white rounded-full h-4 min-w-[16px] px-1 flex items-center justify-center text-[10px]">
                  {col.deliveries.length}
                </span>
              )}
            </div>
            {i < columns.length - 1 && (
              <ChevronRight className="h-3 w-3 text-zinc-300 mx-0.5 shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* Kanban board */}
      {isPending && (
        <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Updating...
        </div>
      )}

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: '400px' }}>
          {columns.map((col, colIdx) => (
            <Droppable key={col.stage.id} droppableId={`col-${colIdx}`}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn(
                    'flex-shrink-0 w-72 rounded-xl border bg-zinc-50/50 flex flex-col',
                    snapshot.isDraggingOver && 'border-blue-300 bg-blue-50/30'
                  )}
                >
                  {/* Column header */}
                  <div className="px-3 py-2.5 border-b bg-white rounded-t-xl">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                        {col.stage.stage_name}
                      </h3>
                      <span className={cn(
                        'text-xs font-medium rounded-full h-5 min-w-[20px] px-1.5 flex items-center justify-center',
                        col.deliveries.length > 0 ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
                      )}>
                        {col.deliveries.length}
                      </span>
                    </div>
                  </div>

                  {/* Cards */}
                  <div className="p-2 flex-1 overflow-y-auto space-y-2 min-h-[80px]">
                    {col.deliveries.map((delivery, idx) => (
                      <Draggable key={delivery.id} draggableId={delivery.id} index={idx}>
                        {(dragProvided, dragSnapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                          >
                            <TrackerCard
                              delivery={delivery}
                              isDragging={dragSnapshot.isDragging}
                              isLastStage={colIdx === columns.length - 1}
                              onComplete={() => handleComplete(delivery.id)}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {col.deliveries.length === 0 && (
                      <p className="text-xs text-zinc-400 text-center py-4">No items</p>
                    )}
                  </div>
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>

      {/* Completed section */}
      {completedDeliveries.length > 0 && (
        <div className="border rounded-xl bg-white">
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
          >
            <span className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              Completed ({completedDeliveries.length})
            </span>
            <ChevronRight className={cn('h-4 w-4 transition-transform', showCompleted && 'rotate-90')} />
          </button>
          {showCompleted && (
            <div className="px-4 pb-3 grid gap-2">
              {completedDeliveries.slice(0, 20).map(d => (
                <div key={d.id} className="flex items-center gap-3 text-sm py-1.5 px-2 rounded bg-zinc-50">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span className="font-medium truncate">{d.company_name ?? d.service_name}</span>
                  <span className="text-xs text-zinc-400 ml-auto shrink-0">
                    {d.end_date ? new Date(d.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
