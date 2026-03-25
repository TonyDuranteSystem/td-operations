'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { Mail, Clock, DollarSign } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface LeadKanbanItem {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: string
  source: string | null
  offer_status: string | null
  offer_year1_amount: number | null
  offer_year1_currency: string | null
  created_at: string
}

interface LeadsKanbanProps {
  items: LeadKanbanItem[]
}

const COLUMNS = [
  { key: 'New', label: 'New', color: 'bg-blue-500' },
  { key: 'Call Scheduled', label: 'Call Scheduled', color: 'bg-cyan-500' },
  { key: 'Call Done', label: 'Call Done', color: 'bg-violet-500' },
  { key: 'Offer Sent', label: 'Offer Sent', color: 'bg-orange-500' },
  { key: 'Negotiating', label: 'Negotiating', color: 'bg-pink-500' },
  { key: 'Converted', label: 'Converted', color: 'bg-emerald-500' },
  { key: 'Lost', label: 'Lost', color: 'bg-zinc-400' },
]

const CARD_BORDER: Record<string, string> = {
  'New': 'border-l-blue-500',
  'Call Scheduled': 'border-l-cyan-500',
  'Call Done': 'border-l-violet-500',
  'Offer Sent': 'border-l-orange-500',
  'Negotiating': 'border-l-pink-500',
  'Converted': 'border-l-emerald-500',
  'Lost': 'border-l-zinc-400',
}

function daysInStage(createdAt: string): number {
  const created = new Date(createdAt)
  const now = new Date()
  return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24))
}

export function LeadsKanban({ items }: LeadsKanbanProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Group items by status
  const columns = COLUMNS.map(col => ({
    ...col,
    items: items.filter(item => item.status === col.key),
  }))

  const handleDragEnd = (result: DropResult) => {
    const { draggableId, destination, source } = result

    if (!destination) return
    if (destination.droppableId === source.droppableId) return

    const newStatus = destination.droppableId
    const leadId = draggableId

    // For certain status transitions, redirect to the lead detail page
    // where admin can use the proper dialog
    if (newStatus === 'Converted') {
      toast.info('Use the lead detail page to convert a lead')
      router.push(`/leads/${leadId}`)
      return
    }

    if (newStatus === 'Lost') {
      toast.info('Use the lead detail page to mark a lead as lost')
      router.push(`/leads/${leadId}`)
      return
    }

    // Simple status update for other transitions
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, status: newStatus }),
        })

        if (!res.ok) {
          const data = await res.json()
          toast.error(data.error || 'Failed to update status')
          return
        }

        toast.success(`Lead moved to ${newStatus}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className={cn('flex gap-3 overflow-x-auto pb-4', isPending && 'opacity-60 pointer-events-none')}>
        {columns.map(col => (
          <div key={col.key} className="flex-shrink-0 w-64">
            {/* Column header */}
            <div className="flex items-center gap-2 mb-3">
              <div className={cn('w-2 h-2 rounded-full', col.color)} />
              <h3 className="text-sm font-semibold text-zinc-700">{col.label}</h3>
              <span className="text-xs text-muted-foreground bg-zinc-100 px-1.5 py-0.5 rounded-full">
                {col.items.length}
              </span>
            </div>

            {/* Droppable column */}
            <Droppable droppableId={col.key}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn(
                    'min-h-[200px] rounded-lg p-2 space-y-2 transition-colors',
                    snapshot.isDraggingOver ? 'bg-blue-50' : 'bg-zinc-50'
                  )}
                >
                  {col.items.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className={cn(
                            'bg-white rounded-lg border border-l-4 p-3 shadow-sm transition-shadow',
                            CARD_BORDER[item.status] || 'border-l-zinc-300',
                            snapshot.isDragging && 'shadow-lg ring-2 ring-blue-200'
                          )}
                        >
                          <Link href={`/leads/${item.id}`} className="block">
                            <p className="text-sm font-medium text-zinc-900 truncate">
                              {item.full_name}
                            </p>

                            {item.email && (
                              <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-1">
                                <Mail className="h-3 w-3 shrink-0" />
                                {item.email}
                              </p>
                            )}

                            <div className="flex items-center justify-between mt-2">
                              {item.offer_year1_amount ? (
                                <span className="text-xs font-medium text-emerald-700 flex items-center gap-0.5">
                                  <DollarSign className="h-3 w-3" />
                                  {item.offer_year1_currency === 'EUR' ? '€' : '$'}
                                  {item.offer_year1_amount.toLocaleString()}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {item.source ?? '—'}
                                </span>
                              )}

                              <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                                <Clock className="h-3 w-3" />
                                {daysInStage(item.created_at)}d
                              </span>
                            </div>
                          </Link>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>
        ))}
      </div>
    </DragDropContext>
  )
}
