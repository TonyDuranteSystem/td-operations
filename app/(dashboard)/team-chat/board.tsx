'use client'

import { useMemo, useState } from 'react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { cn } from '@/lib/utils'
import { Hash, Building2, MessageSquare, Users } from 'lucide-react'
import { TEAM_WORK_STATUSES, TEAM_WORK_STATUS_LABELS, type TeamWorkStatus } from '@/lib/team/workspace'
import type { TeamThread } from './types'

const COLUMN_STYLE: Record<TeamWorkStatus, { top: string; badge: string }> = {
  todo: { top: 'border-t-zinc-400', badge: 'bg-zinc-100 text-zinc-600' },
  in_progress: { top: 'border-t-blue-500', badge: 'bg-blue-100 text-blue-700' },
  waiting: { top: 'border-t-amber-500', badge: 'bg-amber-100 text-amber-700' },
  handled: { top: 'border-t-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
}

function threadIcon(t: TeamThread) {
  if (t.thread_type === 'channel') return <Hash className="h-3.5 w-3.5 text-zinc-400" />
  if (t.thread_type === 'dm') return <MessageSquare className="h-3.5 w-3.5 text-zinc-400" />
  if (t.thread_type === 'general') return <Users className="h-3.5 w-3.5 text-zinc-400" />
  return <Building2 className="h-3.5 w-3.5 text-zinc-400" />
}

/**
 * Team board — one kanban of all work threads. Columns are the four work
 * statuses; each thread is a card you drag between columns to set its status.
 * Filterable by channel. DMs are excluded (not work items).
 */
export function TeamBoard({ threads, channels, onStatusChange, onOpenThread }: {
  threads: TeamThread[]
  channels: TeamThread[]
  onStatusChange: (threadId: string, status: TeamWorkStatus) => void
  onOpenThread: (threadId: string) => void
}) {
  const [channelFilter, setChannelFilter] = useState('')

  const cards = useMemo(() => {
    return threads.filter(t =>
      t.thread_type !== 'dm' &&
      !t.archived_at &&
      (!channelFilter || t.parent_channel_id === channelFilter),
    )
  }, [threads, channelFilter])

  const byStatus = useMemo(() => {
    const map: Record<TeamWorkStatus, TeamThread[]> = { todo: [], in_progress: [], waiting: [], handled: [] }
    for (const t of cards) {
      const s = (t.work_status ?? 'todo') as TeamWorkStatus
      ;(map[s] ?? map.todo).push(t)
    }
    return map
  }, [cards])

  const channelName = (id: string | null) => id ? (channels.find(c => c.id === id)?.channel_slug ?? channels.find(c => c.id === id)?.label ?? null) : null

  const handleDragEnd = (r: DropResult) => {
    if (!r.destination) return
    const status = r.destination.droppableId as TeamWorkStatus
    const from = r.source.droppableId as TeamWorkStatus
    if (status === from) return
    onStatusChange(r.draggableId, status)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-white shrink-0">
        <h2 className="text-sm font-semibold text-zinc-900">Board</h2>
        <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)}
          className="text-xs border border-zinc-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-zinc-300">
          <option value="">All channels</option>
          {channels.map(c => <option key={c.id} value={c.id}>#{c.channel_slug ?? c.label}</option>)}
        </select>
      </div>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-3 h-full p-4 min-w-max">
            {TEAM_WORK_STATUSES.map(status => (
              <div key={status} className="w-72 shrink-0 flex flex-col bg-zinc-50 rounded-xl border border-zinc-200">
                <div className={cn('flex items-center justify-between px-3 py-2 border-t-2 rounded-t-xl', COLUMN_STYLE[status].top)}>
                  <span className="text-xs font-semibold text-zinc-700">{TEAM_WORK_STATUS_LABELS[status]}</span>
                  <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded-full', COLUMN_STYLE[status].badge)}>{byStatus[status].length}</span>
                </div>
                <Droppable droppableId={status}>
                  {(provided, snapshot) => (
                    <div ref={provided.innerRef} {...provided.droppableProps}
                      className={cn('flex-1 overflow-y-auto p-2 space-y-2 min-h-[60px]', snapshot.isDraggingOver && 'bg-zinc-100')}>
                      {byStatus[status].map((t, i) => {
                        const ch = channelName(t.parent_channel_id)
                        return (
                          <Draggable key={t.id} draggableId={t.id} index={i}>
                            {(dp, ds) => (
                              <div ref={dp.innerRef} {...dp.draggableProps} {...dp.dragHandleProps}
                                onClick={() => onOpenThread(t.id)}
                                className={cn('bg-white border border-zinc-200 rounded-lg p-2.5 cursor-pointer hover:border-zinc-300 shadow-sm', ds.isDragging && 'shadow-lg ring-1 ring-zinc-300')}>
                                <div className="flex items-center gap-1.5 mb-1">
                                  {threadIcon(t)}
                                  <span className="text-sm font-medium text-zinc-800 truncate flex-1">
                                    {t.thread_type === 'channel' ? `#${t.channel_slug ?? t.label}` : t.label}
                                  </span>
                                  {t.unread_count > 0 && <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{t.unread_count}</span>}
                                </div>
                                {t.last_message && <p className="text-[11px] text-zinc-500 line-clamp-2">{t.last_message.slice(0, 100)}</p>}
                                {ch && <span className="inline-block mt-1.5 text-[10px] text-zinc-400 bg-zinc-100 rounded px-1.5 py-0.5">#{ch}</span>}
                              </div>
                            )}
                          </Draggable>
                        )
                      })}
                      {provided.placeholder}
                      {byStatus[status].length === 0 && <p className="text-[11px] text-zinc-400 text-center py-4">Nothing here</p>}
                    </div>
                  )}
                </Droppable>
              </div>
            ))}
          </div>
        </div>
      </DragDropContext>
    </div>
  )
}
