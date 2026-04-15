'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, ClipboardList, CheckCircle2 } from 'lucide-react'
import { TaskCard } from '@/components/tasks/task-card'
import type { Task } from '@/lib/types'

/**
 * ThreadTasksPanel — per-thread task list rendered inside /portal-chats as a
 * sub-tab next to Messages. Reads from GET /api/tasks/by-thread and displays
 * tasks for the currently-selected account or contact thread.
 *
 * Reuses the existing TaskCard component so all task actions (complete,
 * reassign, priority adjust) work the same as the standalone /tasks
 * dashboard. Phase 1 of the task-management-inside-chat redesign
 * (2026-04-15) — see session-context sysdoc for the full 4-phase plan.
 */
export function ThreadTasksPanel({
  accountId,
  contactId,
}: {
  accountId: string | null
  contactId: string | null
}) {
  const [includeDone, setIncludeDone] = useState(false)

  const queryKey = ['portal-chat-thread-tasks', accountId ?? contactId, includeDone]
  const queryParam = accountId
    ? `account_id=${accountId}`
    : contactId
      ? `contact_id=${contactId}`
      : null

  const { data, isLoading, error } = useQuery<{ tasks: Task[] }>({
    queryKey,
    queryFn: async () => {
      const url = `/api/tasks/by-thread?${queryParam}${includeDone ? '&include_done=1' : ''}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to load tasks')
      return res.json()
    },
    enabled: !!queryParam,
    refetchInterval: 30_000,
  })

  const today = new Date().toISOString().split('T')[0]
  const tasks = data?.tasks ?? []

  // Group by status for visual sections
  const openTasks = tasks.filter(t => t.status !== 'Done')
  const doneTasks = tasks.filter(t => t.status === 'Done')

  if (!queryParam) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400">Select a conversation</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-red-500">Failed to load tasks</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Controls */}
      <div className="px-4 py-2 border-b bg-zinc-50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <ClipboardList className="h-3.5 w-3.5" />
          <span>{openTasks.length} open · {doneTasks.length} done</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
          <input
            type="checkbox"
            checked={includeDone}
            onChange={e => setIncludeDone(e.target.checked)}
            className="h-3 w-3 rounded"
          />
          Show completed
        </label>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-10 w-10 text-zinc-200 mb-2" />
            <p className="text-sm font-medium text-zinc-500 mb-1">No open tasks</p>
            <p className="text-xs text-zinc-400">Tasks for this client will appear here</p>
          </div>
        ) : (
          <>
            {openTasks.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-1">
                  Open ({openTasks.length})
                </h3>
                {openTasks.map(task => (
                  <TaskCard key={task.id} task={task} today={today} />
                ))}
              </section>
            )}
            {includeDone && doneTasks.length > 0 && (
              <section className="space-y-2 pt-3 border-t">
                <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-1">
                  Done ({doneTasks.length})
                </h3>
                {doneTasks.map(task => (
                  <TaskCard key={task.id} task={task} today={today} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
