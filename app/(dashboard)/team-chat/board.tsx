'use client'

import { useMemo, useState } from 'react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { cn } from '@/lib/utils'
import { Hash, MessageSquare } from 'lucide-react'
import { format } from 'date-fns'
import { TEAM_WORK_STATUSES, TEAM_WORK_STATUS_LABELS, type TeamWorkStatus } from '@/lib/team/workspace'
import type { BoardThread } from './types'

const COLUMN_STYLE: Record<TeamWorkStatus, { top: string; badge: string }> = {
  todo: { top: 'border-t-zinc-400', badge: 'bg-zinc-100 text-zinc-600' },
  in_progress: { top: 'border-t-blue-500', badge: 'bg-blue-100 text-blue-700' },
  waiting: { top: 'border-t-amber-500', badge: 'bg-amber-100 text-amber-700' },
  handled: { top: 'border-t-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
}

/**
 * Team board — a kanban of EVERY THREAD across every channel (the "summary of all
 * threads"). Columns are the four stages; each card is one thread showing the
 * channel it belongs to, bold + a dot when it has new activity for you. Click a
 * card to open that thread; drag it to change its stage.
 *
 * NOTE: this board used to show whole conversations (one card per channel), a
 * different grain that shared the same four labels — filtering it to a channel
 * showed nothing useful, because the threads inside a channel were never on it.
 * Threads are the grain people actually think in, so the board now tracks those.
 */
export function TeamBoard({ threads, onStatusChange, onOpenThread }: {
  threads: BoardThread[]
  onStatusChange: (rootId: string, status: TeamWorkStatus, channelId: string) => void
  onOpenThread: (threadId: string, rootId: string) => void
}) {
  const [channelFilter, setChannelFilter] = useState('')

  const channels = useMemo(
    () => Array.from(new Set(threads.map(t => t.channel_label))).sort(),
    [threads],
  )

  const cards = useMemo(
    () => threads.filter(t => !channelFilter || t.channel_label === channelFilter),
    [threads, channelFilter],
  )

  const byStatus = useMemo(() => {
    const map: Record<TeamWorkStatus, BoardThread[]> = { todo: [], in_progress: [], waiting: [], handled: [] }
    for (const t of cards) {
      const s = (t.status ?? 'todo') as TeamWorkStatus
      ;(map[s] ?? map.todo).push(t)
    }
    // New activity first inside each column.
    for (const k of TEAM_WORK_STATUSES) {
      map[k].sort((a, b) => (a.unread !== b.unread ? (a.unread ? -1 : 1) : (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '')))
    }
    return map
  }, [cards])

  const handleDragEnd = (r: DropResult) => {
    if (!r.destination) return
    const status = r.destination.droppableId as TeamWorkStatus
    if (status === r.source.droppableId) return
    const card = threads.find(t => t.root_message_id === r.draggableId)
    if (card) onStatusChange(card.root_message_id, status, card.thread_id)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-white">
        <h2 className="text-sm font-semibold text-zinc-900">All threads</h2>
        <select
          value={channelFilter}
          onChange={e => setChannelFilter(e.target.value)}
          className="text-xs border border-zinc-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option value="">All channels</option>
          {channels.map(c => <option key={c} value={c}>#{c}</option>)}
        </select>
      </div>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
          <div className="flex gap-3 h-full min-w-max">
            {TEAM_WORK_STATUSES.map(status => (
              <Droppable droppableId={status} key={status}>
                {(dp) => (
                  <div ref={dp.innerRef} {...dp.droppableProps}
                    className={cn('w-72 shrink-0 flex flex-col rounded-xl border-t-4 bg-zinc-50 border border-zinc-200', COLUMN_STYLE[status].top)}>
                    <div className="shrink-0 flex items-center justify-between px-3 py-2.5">
                      <span className="text-sm font-semibold text-zinc-800">{TEAM_WORK_STATUS_LABELS[status]}</span>
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded-full', COLUMN_STYLE[status].badge)}>{byStatus[status].length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
                      {byStatus[status].length === 0 && (
                        <p className="text-xs text-zinc-400 text-center py-6">Nothing here</p>
                      )}
                      {byStatus[status].map((t, i) => (
                        <Draggable key={t.root_message_id} draggableId={t.root_message_id} index={i}>
                          {(d) => (
                            <div ref={d.innerRef} {...d.draggableProps} {...d.dragHandleProps}
                              onClick={() => onOpenThread(t.thread_id, t.root_message_id)}
                              className={cn('rounded-lg bg-white border p-2.5 cursor-pointer hover:border-zinc-300', t.unread ? 'border-blue-300' : 'border-zinc-200')}>
                              <div className="flex items-center gap-1.5 mb-1">
                                {t.unread && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />}
                                <Hash className="h-3 w-3 text-zinc-400 shrink-0" />
                                <span className="text-[10px] text-zinc-500 truncate">{t.channel_label}</span>
                              </div>
                              <p className={cn('text-xs line-clamp-3', t.unread ? 'font-semibold text-zinc-900' : 'text-zinc-700')}>{t.title}</p>
                              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-zinc-400">
                                <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" />{t.reply_count}</span>
                                {t.last_activity_at && <span>{format(new Date(t.last_activity_at), 'MMM d')}</span>}
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {dp.placeholder}
                    </div>
                  </div>
                )}
              </Droppable>
            ))}
          </div>
        </div>
      </DragDropContext>
    </div>
  )
}
